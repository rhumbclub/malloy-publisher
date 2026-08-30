// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import type * as Malloy from "@malloydata/malloy-interfaces";
import { isTableResult, normalizeExportName } from "../../utils/xlsxExport";
import type { EnhancedNotebookCell } from "./types";

export interface NotebookTableExport {
   name: string;
   result: Malloy.Result;
}

function headings(markdown: string, level: string): string[] {
   const expression = new RegExp(`^${level}\\s+(.+?)\\s*#*\\s*$`, "gm");
   return Array.from(markdown.matchAll(expression), (match) => match[1]);
}

export function notebookTableExports(
   cells: EnhancedNotebookCell[],
   notebookPath: string,
): Array<NotebookTableExport | undefined> {
   const title =
      cells
         .filter((cell) => cell.type === "markdown")
         .flatMap((cell) => headings(cell.text, "#"))[0] ??
      notebookPath
         .split("/")
         .pop()
         ?.replace(/\.malloynb$/i, "") ??
      "notebook";
   let section: string | undefined;
   let ordinal = 0;

   return cells.map((cell) => {
      if (cell.type === "markdown") {
         section = headings(cell.text, "#{2,6}").at(-1) ?? section;
         return undefined;
      }
      if (!cell.result) return undefined;
      try {
         const result = JSON.parse(cell.result) as Malloy.Result;
         if (!isTableResult(result)) return undefined;
         ordinal += 1;
         return {
            result,
            name: normalizeExportName(
               [title, section, `table-${ordinal}`].filter(Boolean).join("-"),
            ),
         };
      } catch {
         return undefined;
      }
   });
}
