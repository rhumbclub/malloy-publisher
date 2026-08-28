// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Package } from "./service/package";
import {
   getComparisonCatalog,
   runComparisonReport,
} from "./comparison_reports";

const roots: string[] = [];

afterEach(() => {
   for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

function fixture() {
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
               rows: [
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
   return { pkg, sql: () => sql };
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
            filters: ["start", "end", "harbor", "variant"],
            variants: ["default", "canonical"],
         },
      ]);
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
