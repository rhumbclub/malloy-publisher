// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import GridOnIcon from "@mui/icons-material/GridOn";
import {
   Box,
   CircularProgress,
   IconButton,
   Snackbar,
   Tooltip,
} from "@mui/material";
import type * as Malloy from "@malloydata/malloy-interfaces";
import { useMemo, useState } from "react";
import { downloadFlatResult, isFlatResult } from "../../utils/xlsxExport";

interface XlsxDownloadButtonProps {
   result?: Malloy.Result;
}

export function XlsxDownloadButton({ result }: XlsxDownloadButtonProps) {
   const [exporting, setExporting] = useState(false);
   const [exportFailed, setExportFailed] = useState(false);
   const exportable = useMemo(
      () => result !== undefined && isFlatResult(result),
      [result],
   );

   if (!exportable || !result) return null;

   const download = async () => {
      setExporting(true);
      setExportFailed(false);
      try {
         await downloadFlatResult(result);
      } catch (error) {
         console.error("XLSX export failed:", error);
         setExportFailed(true);
      } finally {
         setExporting(false);
      }
   };

   return (
      <>
         <Box className="publisher-xlsx-export">
            <Tooltip title="Download Excel (.xlsx)">
               <span>
                  <IconButton
                     aria-label="Download Excel (.xlsx)"
                     disabled={exporting}
                     onClick={download}
                     size="small"
                     sx={{
                        width: 28,
                        height: 28,
                        color: "#217346",
                        backgroundColor: "background.paper",
                        "&:hover": { backgroundColor: "action.hover" },
                     }}
                  >
                     {exporting ? (
                        <CircularProgress size={16} color="inherit" />
                     ) : (
                        <GridOnIcon sx={{ fontSize: 18 }} />
                     )}
                  </IconButton>
               </span>
            </Tooltip>
         </Box>
         <Snackbar
            open={exportFailed}
            autoHideDuration={5000}
            message="Excel export failed. Please try again."
            onClose={() => setExportFailed(false)}
         />
      </>
   );
}
