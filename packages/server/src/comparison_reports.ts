// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getMaxResponseBytes, getQueryTimeoutMs } from "./config";
import { InvalidArgumentError, NotQueryableError } from "./errors";
import { bigIntReplacer } from "./json_utils";
import { tryAcquireQuerySlot } from "./query_concurrency";
import { runWithQueryTimeout } from "./query_timeout";
import { stringifyQueryResponse } from "./service/model_limits";
import type { Package } from "./service/package";

const PAGE_SIZE = 100;
const MANIFEST = "comparison-reports.json";
const filterName = z.enum([
   "start",
   "end",
   "harbor",
   "member",
   "variant",
   "transactionType",
]);
const reportSchema = z.object({
   slug: z.string().regex(/^[a-z0-9-]+$/),
   name: z.string().min(1),
   group: z.string().min(1),
   status: z.string().min(1),
   description: z.string().min(1),
   filters: z.array(filterName),
   variants: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
   sql: z.string().min(1),
});
const manifestSchema = z.object({
   warning: z.string().min(1),
   privacyProfile: z.string().min(1),
   connection: z.string().min(1),
   snippets: z.record(z.string().regex(/^[A-Z_]+$/), z.string()).optional(),
   reports: z.array(reportSchema).min(1),
});
const inputSchema = z
   .object({
      start: z.string().optional(),
      end: z.string().optional(),
      harbor: z.string().optional(),
      member: z.string().optional(),
      variant: z.string().optional(),
      transactionType: z.number().int().optional(),
      cursor: z.string().max(16).optional(),
   })
   .strict();

type Manifest = z.infer<typeof manifestSchema>;
type Report = z.infer<typeof reportSchema>;
export type ComparisonFilters = z.infer<typeof inputSchema>;

function packageFile(pkg: Package, relative: string): string {
   const root = path.resolve(pkg.getPackagePath());
   const file = path.resolve(root, relative);
   if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
      throw new InvalidArgumentError(
         "Comparison report SQL must remain inside the package.",
      );
   }
   return file;
}

async function loadManifest(pkg: Package): Promise<Manifest> {
   let parsed: unknown;
   try {
      parsed = JSON.parse(
         await fs.readFile(packageFile(pkg, MANIFEST), "utf8"),
      );
   } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
         throw new NotQueryableError(
            "This package does not publish comparison reports.",
         );
      }
      throw error;
   }
   const manifest = manifestSchema.parse(parsed);
   const slugs = new Set<string>();
   for (const report of manifest.reports) {
      if (slugs.has(report.slug)) {
         throw new InvalidArgumentError(
            `Comparison report slug '${report.slug}' is duplicated.`,
         );
      }
      slugs.add(report.slug);
   }
   return manifest;
}

function catalogReport({ sql: _sql, ...report }: Report) {
   return report;
}

export async function hasComparisonReports(pkg: Package): Promise<boolean> {
   if (typeof pkg.getPackagePath !== "function") return false;
   return fs
      .access(packageFile(pkg, MANIFEST))
      .then(() => true)
      .catch(() => false);
}

export async function getComparisonCatalog(pkg: Package) {
   const manifest = await loadManifest(pkg);
   return {
      warning: manifest.warning,
      privacyProfile: manifest.privacyProfile,
      reports: manifest.reports.map(catalogReport),
   };
}

function validDate(value: string): boolean {
   if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
   const date = new Date(`${value}T00:00:00Z`);
   return (
      !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
   );
}

function cursorPage(cursor?: string): number {
   if (!cursor) return 1;
   const decoded = Buffer.from(cursor, "base64url").toString("utf8");
   const page = Number(decoded);
   if (
      !/^[1-9]\d{0,4}$/.test(decoded) ||
      page > 10_000 ||
      Buffer.from(decoded).toString("base64url") !== cursor
   ) {
      throw new InvalidArgumentError("cursor is invalid.");
   }
   return page;
}

function normalizeFilters(report: Report, input: unknown) {
   const parsed = inputSchema.parse(input ?? {});
   const now = new Date();
   const today = now.toISOString().slice(0, 10);
   const supported = new Set(report.filters);
   for (const key of Object.keys(parsed)) {
      if (
         key !== "cursor" &&
         !supported.has(key as z.infer<typeof filterName>)
      ) {
         throw new InvalidArgumentError(
            `Filter '${key}' is not supported by report '${report.slug}'.`,
         );
      }
   }
   const filters = {
      start: parsed.start ?? `${today.slice(0, 8)}01`,
      end: parsed.end ?? today,
      harbor: (parsed.harbor ?? "ALL").toUpperCase(),
      member: (parsed.member ?? "").trim().toUpperCase(),
      variant: (
         parsed.variant ??
         report.variants?.[0] ??
         "default"
      ).toLowerCase(),
      transactionType: parsed.transactionType ?? -1,
      page: cursorPage(parsed.cursor),
   };
   if (!validDate(filters.start) || !validDate(filters.end)) {
      throw new InvalidArgumentError(
         "start and end must be real YYYY-MM-DD dates.",
      );
   }
   if (filters.start > filters.end) {
      throw new InvalidArgumentError("start must not be after end.");
   }
   if (
      !new Set(["ALL", "CI", "LB", "MDR", "NB", "RB", "SD"]).has(filters.harbor)
   ) {
      throw new InvalidArgumentError("harbor is not recognized.");
   }
   if (filters.member && !/^[A-Z0-9-]{1,20}$/.test(filters.member)) {
      throw new InvalidArgumentError("member must be a valid member code.");
   }
   if (filters.transactionType < -1 || filters.transactionType > 9999) {
      throw new InvalidArgumentError(
         "transactionType or page is out of range.",
      );
   }
   if (report.variants && !report.variants.includes(filters.variant)) {
      throw new InvalidArgumentError(
         `variant must be one of: ${report.variants.join(", ")}.`,
      );
   }
   return filters;
}

function buildSQL(
   template: string,
   filters: ReturnType<typeof normalizeFilters>,
   snippets: Record<string, string> = {},
) {
   const values = {
      START: filters.start,
      END: filters.end,
      HARBOR: filters.harbor,
      MEMBER: filters.member,
      VARIANT: filters.variant,
      TYPE: String(filters.transactionType),
      LIMIT: String(PAGE_SIZE),
      OFFSET: String((filters.page - 1) * PAGE_SIZE),
   };
   let sql = template;
   for (const [name, value] of Object.entries(snippets)) {
      sql = sql.replaceAll(`{{${name}}}`, value);
   }
   for (const [name, value] of Object.entries(values)) {
      sql = sql.replaceAll(`{{${name}}}`, value);
   }
   if (/{{[A-Z_]+}}/.test(sql)) {
      throw new InvalidArgumentError(
         "Comparison report SQL has an unresolved placeholder.",
      );
   }
   return sql;
}

function lineage(privacyProfile: string) {
   try {
      const value = JSON.parse(
         process.env.PUBLISHER_SNAPSHOT_LINEAGE ?? "{}",
      ) as Record<string, unknown>;
      return { privacyProfile, ...value };
   } catch {
      return { privacyProfile };
   }
}

export async function runComparisonReport(
   pkg: Package,
   slug: string,
   input: unknown,
) {
   const manifest = await loadManifest(pkg);
   const report = manifest.reports.find((candidate) => candidate.slug === slug);
   if (!report)
      throw new NotQueryableError(`Comparison report '${slug}' was not found.`);
   const filters = normalizeFilters(report, input);
   const template = await fs.readFile(packageFile(pkg, report.sql), "utf8");
   const slot = tryAcquireQuerySlot("comparison-report");
   try {
      const connection = await pkg.getMalloyConnection(manifest.connection);
      const result = await runWithQueryTimeout(
         (abortSignal) =>
            connection.runSQL(buildSQL(template, filters, manifest.snippets), {
               rowLimit: PAGE_SIZE,
               abortSignal,
            }),
         getQueryTimeoutMs(),
      );
      const rows = result.rows.map((row) => ({ ...row }));
      const summary: Record<string, unknown> = {};
      let totalRows = 0;
      for (const [key, value] of Object.entries(rows[0] ?? {})) {
         if (key === "_total_rows") totalRows = Number(value);
         else if (key.startsWith("_")) summary[key.slice(1)] = value;
      }
      for (const row of rows) {
         for (const key of Object.keys(row))
            if (key.startsWith("_")) delete row[key];
      }
      const pages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
      const payload = {
         report: catalogReport(report),
         slug,
         filters,
         rows,
         summary,
         totalRows,
         page: filters.page,
         pageSize: PAGE_SIZE,
         previousCursor:
            filters.page > 1
               ? Buffer.from(String(filters.page - 1)).toString("base64url")
               : null,
         nextCursor:
            filters.page < pages
               ? Buffer.from(String(filters.page + 1)).toString("base64url")
               : null,
         warning: manifest.warning,
         snapshot: lineage(manifest.privacyProfile),
      };
      const serialized = stringifyQueryResponse(
         payload,
         rows.length,
         getMaxResponseBytes(),
         "model_query",
         bigIntReplacer,
      );
      return {
         payload: JSON.parse(serialized) as typeof payload,
         serialized,
      };
   } finally {
      slot.release();
   }
}
