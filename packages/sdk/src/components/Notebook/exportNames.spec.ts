// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import type * as Malloy from "@malloydata/malloy-interfaces";
import { notebookTableExports } from "./exportNames";
import type { EnhancedNotebookCell } from "./types";

const tableResult = {
   connection_name: "duckdb",
   schema: {
      fields: [
         { kind: "dimension", name: "harbor", type: { kind: "string_type" } },
      ],
   },
   data: {
      kind: "array_cell",
      array_value: [
         {
            kind: "record_cell",
            record_value: [{ kind: "string_cell", string_value: "MDR" }],
         },
      ],
   },
} as Malloy.Result;

function cells(): EnhancedNotebookCell[] {
   return [
      { type: "markdown", text: "# August Revenue\n\n## Lessons" },
      {
         type: "code",
         text: "run: lessons",
         result: JSON.stringify(tableResult),
      },
      {
         type: "code",
         text: "run: chart",
         result: JSON.stringify({
            ...tableResult,
            annotations: [{ value: "# line_chart" }],
         }),
      },
      { type: "markdown", text: "### Detail" },
      {
         type: "code",
         text: "run: detail",
         result: JSON.stringify(tableResult),
      },
   ];
}

describe("notebook table exports", () => {
   test("numbers only flat table renderings and includes the nearest heading", () => {
      const exports = notebookTableExports(cells(), "finance/revenue.malloynb");
      expect(exports.map((item) => item?.name)).toEqual([
         undefined,
         "august-revenue-lessons-table-1",
         undefined,
         undefined,
         "august-revenue-detail-table-2",
      ]);
   });
});
