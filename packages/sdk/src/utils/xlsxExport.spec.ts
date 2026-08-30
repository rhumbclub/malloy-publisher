// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import type * as Malloy from "@malloydata/malloy-interfaces";
import {
   flatResultSheet,
   isFlatResult,
   isTableResult,
   xlsxFilename,
} from "./xlsxExport";

const flatResult: Malloy.Result = {
   connection_name: "duckdb",
   schema: {
      fields: [
         { kind: "dimension", name: "name", type: { kind: "string_type" } },
         { kind: "measure", name: "amount", type: { kind: "number_type" } },
         { kind: "dimension", name: "active", type: { kind: "boolean_type" } },
         { kind: "dimension", name: "day", type: { kind: "date_type" } },
         {
            kind: "dimension",
            name: "observed_at",
            type: { kind: "timestamp_type" },
         },
         { kind: "dimension", name: "exact_id", type: { kind: "number_type" } },
         { kind: "dimension", name: "missing", type: { kind: "string_type" } },
      ],
   },
   data: {
      kind: "array_cell",
      array_value: [
         {
            kind: "record_cell",
            record_value: [
               { kind: "string_cell", string_value: "=2+2" },
               { kind: "number_cell", number_value: 1234.5 },
               { kind: "boolean_cell", boolean_value: true },
               { kind: "date_cell", date_value: "2026-08-29" },
               {
                  kind: "timestamp_cell",
                  timestamp_value: "2026-08-29T15:30:00Z",
               },
               {
                  kind: "number_cell",
                  number_value: 9007199254740992,
                  string_value: "9007199254740993",
                  subtype: "bigint",
               },
               { kind: "null_cell" },
            ],
         },
      ],
   },
};

describe("flat XLSX export", () => {
   test("builds a normalized semantic filename with the local date", () => {
      expect(
         xlsxFilename("  Café Revenue / By Harbor ", new Date(2026, 7, 29)),
      ).toBe("cafe-revenue-by-harbor-2026-08-29.xlsx");
   });

   test("exports flat table renderings but not other renderer types", () => {
      expect(isTableResult(flatResult)).toBe(true);
      expect(
         isTableResult({
            ...flatResult,
            annotations: [{ value: "# transpose" }],
         } as Malloy.Result),
      ).toBe(true);
      expect(
         isTableResult({
            ...flatResult,
            source_annotations: [{ value: "# bar_chart" }],
         } as Malloy.Result),
      ).toBe(false);
      expect(
         isTableResult({
            ...flatResult,
            model_annotations: [{ value: "# dashboard" }],
         } as Malloy.Result),
      ).toBe(false);
   });

   test("preserves schema order and spreadsheet-safe scalar values", () => {
      expect(isFlatResult(flatResult)).toBe(true);
      expect(flatResultSheet(flatResult)).toEqual([
         [
            { value: "name", fontWeight: "bold" },
            { value: "amount", fontWeight: "bold" },
            { value: "active", fontWeight: "bold" },
            { value: "day", fontWeight: "bold" },
            { value: "observed_at", fontWeight: "bold" },
            { value: "exact_id", fontWeight: "bold" },
            { value: "missing", fontWeight: "bold" },
         ],
         [
            "=2+2",
            1234.5,
            true,
            new Date(Date.UTC(2026, 7, 29)),
            "2026-08-29T15:30:00Z",
            "9007199254740993",
            null,
         ],
      ]);
   });

   test("exports headers for an empty flat result", () => {
      const empty = {
         ...flatResult,
         data: { kind: "array_cell", array_value: [] },
      } as Malloy.Result;
      expect(flatResultSheet(empty)).toHaveLength(1);
   });

   test("rejects nested result cells", () => {
      const nested = {
         ...flatResult,
         schema: {
            fields: [
               {
                  kind: "dimension",
                  name: "items",
                  type: {
                     kind: "array_type",
                     element_type: { kind: "string_type" },
                  },
               },
            ],
         },
         data: {
            kind: "array_cell",
            array_value: [
               {
                  kind: "record_cell",
                  record_value: [{ kind: "array_cell", array_value: [] }],
               },
            ],
         },
      } as Malloy.Result;

      expect(isFlatResult(nested)).toBe(false);
      expect(() => flatResultSheet(nested)).toThrow("Only flat Malloy results");
   });
});
