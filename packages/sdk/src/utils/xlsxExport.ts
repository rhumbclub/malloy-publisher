// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import type * as Malloy from "@malloydata/malloy-interfaces";
import { parseAnnotation } from "@malloydata/malloy-tag";
import type { Cell as XlsxCell, SheetData } from "write-excel-file/browser";

const nonTableRenderers = [
   "bar_chart",
   "big_value",
   "dashboard",
   "image",
   "json",
   "line_chart",
   "list",
   "list_detail",
   "point_map",
   "scatter_chart",
   "segment_map",
   "shape_map",
   "sparkline",
   "sparkline_area",
   "sparkline_bar",
   "sparkline_column",
   "url",
];

const excelRowOnlyFreeze = {
   files: {
      transform: {
         "xl/worksheets/sheet{id}.xml": {
            transform: (xml: string) =>
               xml.replace(
                  '<pane ySplit="1" xSplit="0" topLeftCell="A2" activePane="bottomRight" state="frozen"/>',
                  '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
               ),
         },
      },
   },
};

const scalarCellKinds = new Set<Malloy.Cell["kind"]>([
   "string_cell",
   "boolean_cell",
   "date_cell",
   "timestamp_cell",
   "number_cell",
   "json_cell",
   "null_cell",
   "sql_native_cell",
]);

function isScalarField(field: Malloy.FieldInfo): boolean {
   return (
      field.kind !== "join" &&
      field.kind !== "view" &&
      field.type.kind !== "array_type" &&
      field.type.kind !== "record_type"
   );
}

export function isFlatResult(result: Malloy.Result): boolean {
   const fields = result.schema?.fields;
   if (!fields?.length || !fields.every(isScalarField)) return false;
   if (!result.data) return true;
   if (result.data.kind !== "array_cell") return false;

   return result.data.array_value.every(
      (row) =>
         row.kind === "record_cell" &&
         row.record_value.length === fields.length &&
         row.record_value.every((cell) => scalarCellKinds.has(cell.kind)),
   );
}

export function normalizeExportName(value: string): string {
   return (
      value
         .normalize("NFKD")
         .replace(/\p{Mark}/gu, "")
         .toLocaleLowerCase()
         .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
         .replace(/^-|-$/g, "") || "export"
   );
}

export function xlsxFilename(name: string, date = new Date()): string {
   const localDate = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
   ].join("-");
   return `${normalizeExportName(name)}-${localDate}.xlsx`;
}

export function isTableResult(result: Malloy.Result): boolean {
   if (!isFlatResult(result)) return false;
   const annotated = result as Malloy.Result & {
      annotations?: Array<{ value?: string }>;
      model_annotations?: Array<{ value?: string }>;
      source_annotations?: Array<{ value?: string }>;
   };
   const lines = [
      ...(annotated.model_annotations ?? []),
      ...(annotated.source_annotations ?? []),
      ...(annotated.annotations ?? []),
   ]
      .map((annotation) => annotation.value)
      .filter((value): value is string => typeof value === "string");
   try {
      const tag = parseAnnotation(lines).tag;
      return !nonTableRenderers.some((renderer) => tag.has(renderer));
   } catch {
      return false;
   }
}

function excelDate(value: string): Date | string {
   const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
   if (!match) return value;
   return new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
   );
}

function excelCell(cell: Malloy.Cell): XlsxCell {
   switch (cell.kind) {
      case "string_cell":
         return cell.string_value;
      case "boolean_cell":
         return cell.boolean_value;
      case "date_cell":
         return excelDate(cell.date_value);
      case "timestamp_cell":
         return cell.timestamp_value;
      case "number_cell":
         return cell.subtype === "bigint" &&
            cell.string_value !== undefined &&
            !Number.isSafeInteger(cell.number_value)
            ? cell.string_value
            : cell.number_value;
      case "json_cell":
         return cell.json_value;
      case "null_cell":
         return null;
      case "sql_native_cell":
         return cell.sql_native_value;
      case "record_cell":
      case "array_cell":
         throw new Error("Nested Malloy results cannot be exported to XLSX.");
   }
}

export function flatResultSheet(result: Malloy.Result): SheetData {
   if (!isFlatResult(result)) {
      throw new Error("Only flat Malloy results can be exported to XLSX.");
   }

   const rows: SheetData = [
      result.schema.fields.map((field) => ({
         value: field.name,
         fontWeight: "bold",
      })),
   ];
   if (result.data?.kind === "array_cell") {
      for (const row of result.data.array_value) {
         if (row.kind === "record_cell") {
            rows.push(row.record_value.map(excelCell));
         }
      }
   }
   return rows;
}

export async function downloadFlatResult(
   result: Malloy.Result,
   name: string,
): Promise<void> {
   const { default: writeXlsxFile } = await import("write-excel-file/browser");
   await writeXlsxFile(
      flatResultSheet(result),
      {
         sheet: "Data",
         stickyRowsCount: 1,
         dateFormat: "yyyy-mm-dd",
      },
      {
         features: [excelRowOnlyFreeze],
      },
   ).toFile(xlsxFilename(name));
}
