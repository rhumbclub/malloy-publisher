// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extract from "extract-zip";
import type { Package } from "./service/package";
import {
   exportComparisonReportXlsx,
   getComparisonCatalog,
   runComparisonReport,
} from "./comparison_reports";
import { PayloadTooLargeError } from "./errors";

const roots: string[] = [];

afterEach(() => {
   for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

function fixture(rows?: Array<Record<string, unknown>>) {
   const root = fs.mkdtempSync(path.join(os.tmpdir(), "comparison-reports-"));
   roots.push(root);
   fs.mkdirSync(path.join(root, "reports"));
   fs.writeFileSync(
      path.join(root, "comparison-reports.json"),
      JSON.stringify({
         warning: "Comparison only.",
         privacyProfile: "preprd",
         connection: "snapshot",
         reports: [
            {
               slug: "sample",
               name: "Sample",
               group: "Tests",
               status: "comparison",
               description: "A fixed query.",
               root: "members",
               grain: "one row per member",
               sourceFields: ["members.member_id"],
               expressions: ["amount = ledger amount"],
               aggregation: "sum amount across returned rows",
               compatibility: ["raw harbor comparison"],
               filters: ["start", "end", "harbor", "variant"],
               variants: ["default", "canonical"],
               sql: "reports/sample.sql",
            },
         ],
      }),
   );
   fs.writeFileSync(
      path.join(root, "reports", "sample.sql"),
      "SELECT '{{START}}' start_date, '{{END}}' end_date, '{{HARBOR}}' harbor, '{{VARIANT}}' variant LIMIT {{LIMIT}} OFFSET {{OFFSET}}",
   );
   let sql = "";
   const pkg = {
      getPackagePath: () => root,
      getMalloyConnection: async () => ({
         runSQL: async (value: string) => {
            sql = value;
            return {
               rows: rows ?? [
                  {
                     member: "Masked member ABC",
                     amount: 12n,
                     _amount: 12n,
                     _total_rows: 1n,
                  },
               ],
            };
         },
      }),
   } as unknown as Package;
   return { pkg, root, sql: () => sql };
}

describe("comparison reports", () => {
   it("loads the package catalog without exposing SQL paths", async () => {
      const { pkg } = fixture();
      const catalog = await getComparisonCatalog(pkg);
      expect(catalog.warning).toBe("Comparison only.");
      expect(catalog.reports).toEqual([
         {
            slug: "sample",
            name: "Sample",
            group: "Tests",
            status: "comparison",
            description: "A fixed query.",
            root: "members",
            grain: "one row per member",
            sourceFields: ["members.member_id"],
            expressions: ["amount = ledger amount"],
            aggregation: "sum amount across returned rows",
            compatibility: ["raw harbor comparison"],
            filters: ["start", "end", "harbor", "variant"],
            variants: ["default", "canonical"],
         },
      ]);
   });

   it("reports the runtime snapshot privacy profile", async () => {
      const { pkg } = fixture();
      const previous = process.env.PUBLISHER_SNAPSHOT_LINEAGE;
      process.env.PUBLISHER_SNAPSHOT_LINEAGE = JSON.stringify({
         privacyProfile: "prd",
      });
      try {
         expect((await getComparisonCatalog(pkg)).privacyProfile).toBe("prd");
      } finally {
         if (previous === undefined) {
            delete process.env.PUBLISHER_SNAPSHOT_LINEAGE;
         } else {
            process.env.PUBLISHER_SNAPSHOT_LINEAGE = previous;
         }
      }
   });

   it("validates filters, executes fixed SQL, and strips summary columns", async () => {
      const { pkg, sql } = fixture();
      const result = await runComparisonReport(pkg, "sample", {
         start: "2026-08-01",
         end: "2026-08-27",
         harbor: "MDR",
         variant: "canonical",
         cursor: Buffer.from("2").toString("base64url"),
      });
      expect(sql()).toContain("'2026-08-01' start_date");
      expect(sql()).toContain("'MDR' harbor");
      expect(sql()).toContain("LIMIT 100 OFFSET 100");
      expect(result.payload.rows).toEqual([
         { member: "Masked member ABC", amount: 12 },
      ]);
      expect(result.payload.summary).toEqual({ amount: 12 });
      expect(result.payload.totalRows).toBe(1);
      expect(result.payload.warning).toBe("Comparison only.");
   });

   it("exports all filtered rows as a frozen-header workbook", async () => {
      const { pkg, root, sql } = fixture([
         {
            member: "Masked member ABC",
            amount: 12n,
            active: true,
            day: new Date("2026-08-01T00:00:00Z"),
            _total_rows: 2n,
         },
         {
            member: "Masked member DEF",
            amount: 9007199254740993n,
            active: false,
            day: new Date("2026-08-02T00:00:00Z"),
            _total_rows: 2n,
         },
      ]);

      const workbook = await exportComparisonReportXlsx(pkg, "sample", {
         start: "2026-08-01",
         end: "2026-08-27",
         harbor: "MDR",
         variant: "canonical",
      });

      expect(sql()).toContain("LIMIT 100001 OFFSET 0");
      expect(workbook.rows).toBe(2);
      expect(workbook.buffer.subarray(0, 4)).toEqual(
         Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      );
      const file = path.join(root, "sample.xlsx");
      const unpacked = path.join(root, "unpacked");
      fs.writeFileSync(file, workbook.buffer);
      await extract(file, { dir: unpacked });
      const sheetXml = fs.readFileSync(
         path.join(unpacked, "xl/worksheets/sheet1.xml"),
         "utf8",
      );
      expect(sheetXml).toContain(
         '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
      );
      expect(sheetXml).toContain('<c r="B3" t="s">');
      expect(
         fs.readFileSync(path.join(unpacked, "xl/sharedStrings.xml"), "utf8"),
      ).toContain("9007199254740993");
   });

   it("fails rather than truncating an oversized export", async () => {
      const previous = process.env.PUBLISHER_MAX_QUERY_ROWS;
      process.env.PUBLISHER_MAX_QUERY_ROWS = "1";
      try {
         const { pkg } = fixture([
            { member: "A", _total_rows: 2n },
            { member: "B", _total_rows: 2n },
         ]);
         await expect(
            exportComparisonReportXlsx(pkg, "sample", {}),
         ).rejects.toBeInstanceOf(PayloadTooLargeError);
      } finally {
         if (previous === undefined)
            delete process.env.PUBLISHER_MAX_QUERY_ROWS;
         else process.env.PUBLISHER_MAX_QUERY_ROWS = previous;
      }
   });

   it("rejects a filter the report does not allow", async () => {
      const { pkg } = fixture();
      await expect(
         runComparisonReport(pkg, "sample", { member: "ABC" }),
      ).rejects.toThrow("'member' is not supported");
   });

   it("rejects a fabricated pagination cursor", async () => {
      const { pkg } = fixture();
      await expect(
         runComparisonReport(pkg, "sample", { cursor: "not-a-cursor" }),
      ).rejects.toThrow("cursor is invalid");
   });

   it("rejects SQL traversal from the package manifest", async () => {
      const { pkg } = fixture();
      const root = pkg.getPackagePath();
      const manifest = JSON.parse(
         fs.readFileSync(path.join(root, "comparison-reports.json"), "utf8"),
      );
      manifest.reports[0].sql = "../secret.sql";
      fs.writeFileSync(
         path.join(root, "comparison-reports.json"),
         JSON.stringify(manifest),
      );
      await expect(runComparisonReport(pkg, "sample", {})).rejects.toThrow(
         "inside the package",
      );
   });
});
