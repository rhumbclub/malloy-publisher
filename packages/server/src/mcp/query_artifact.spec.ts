// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "bun:test";
import {
   MCP_PREVIEW_ROWS,
   persistQueryArtifact,
   queryArtifactContext,
} from "./query_artifact";

describe("MCP query artifacts", () => {
   it("accepts only an edge-minted request id and principal", () => {
      const context = queryArtifactContext(
         {
            "x-rhumbclub-query-id": "qr_1111111111111111111111",
            "x-rhumbclub-principal-hash": "0123456789abcdef",
         },
         {
            MCP_QUERY_RESULTS_BUCKET: "private-results",
            MCP_QUERY_RESULTS_URL: "https://mcp.uat.msail.co/analysis/results",
         },
      );
      expect(context).toEqual({
         requestId: "qr_1111111111111111111111",
         key: "results/0123456789abcdef/qr_1111111111111111111111.json",
         bucket: "private-results",
         url: "https://mcp.uat.msail.co/analysis/results/qr_1111111111111111111111",
      });
      expect(() =>
         queryArtifactContext(
            { "x-rhumbclub-query-id": "not-a-query-id" },
            {},
         ),
      ).toThrow("query id");
   });

   it("writes the complete result while reporting the inline preview size", async () => {
      const sent: unknown[] = [];
      const context = {
         requestId: "qr_1111111111111111111111",
         key: "results/0123456789abcdef/qr_1111111111111111111111.json",
         bucket: "private-results",
         url: "https://mcp.uat.msail.co/analysis/results/qr_1111111111111111111111",
      };
      const rows = Array.from({ length: MCP_PREVIEW_ROWS + 1 }, (_, i) => ({ i }));
      const metadata = await persistQueryArtifact(
         context,
         { rows },
         { send: async (command: unknown) => sent.push(command) } as never,
      );
      expect(metadata).toEqual({
         _request_id: context.requestId,
         _result_url: context.url,
         _result_rows: MCP_PREVIEW_ROWS + 1,
         _preview_row_limit: MCP_PREVIEW_ROWS,
         _preview_truncated: true,
      });
      expect(sent).toHaveLength(1);
      expect(JSON.parse(String((sent[0] as { input: { Body: string } }).input.Body)).rows).toHaveLength(
         MCP_PREVIEW_ROWS + 1,
      );
   });
});
