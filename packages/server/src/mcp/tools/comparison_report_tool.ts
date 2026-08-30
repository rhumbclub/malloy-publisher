// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
   getComparisonCatalog,
   runComparisonReport,
} from "../../comparison_reports";
import { logger } from "../../logger";
import { EnvironmentStore } from "../../service/environment_store";
import { buildMalloyUri, classifyToolError } from "../handler_utils";
import { jsonResource, jsonToolError } from "../tool_response";
import { persistQueryArtifact, queryArtifactContext } from "../query_artifact";

const filters = z
   .object({
      start: z.string().optional(),
      end: z.string().optional(),
      harbor: z.string().optional(),
      member: z.string().optional(),
      variant: z.string().optional(),
      transactionType: z.number().int().optional(),
      cursor: z.string().max(16).optional(),
   })
   .strict()
   .optional();

const shape = {
   environmentName: z
      .string()
      .describe("Environment containing the comparison package."),
   packageName: z
      .string()
      .describe(
         "Package returned by malloy_getContext that publishes comparison reports.",
      ),
   reportName: z
      .string()
      .optional()
      .describe(
         "Fixed comparison-report slug. Omit it to list the package's comparison reports.",
      ),
   filters,
};

const DESCRIPTION = `List or run fixed reports that exist only to compare with the Bluelake Software ERP UI. Omit reportName to list them. The response warning is mandatory context: these reports can preserve known incorrect calculations and dimension handling, so never use them for analysis or decisions. Use the governed package through malloy_getContext and malloy_executeQuery for current metrics. A report run receives a durable qr_ request ID and authenticated complete JSON result URL; clients advertising io.modelcontextprotocol/tasks may poll tasks/get instead of waiting.`;

export function registerComparisonReportTool(
   mcpServer: McpServer,
   environmentStore: EnvironmentStore,
): void {
   mcpServer.tool(
      "malloy_runComparisonReport",
      DESCRIPTION,
      shape,
      async ({ environmentName, packageName, reportName, filters }, extra) => {
         const uri = buildMalloyUri(
            { environment: environmentName, package: packageName },
            reportName
               ? `comparison-report/${reportName}`
               : "comparison-reports",
         );
         try {
            const environment = await environmentStore.getEnvironment(
               environmentName,
               false,
            );
            const pkg = await environment.getPackage(packageName, false);
            if (!reportName) {
               return jsonResource(uri, await getComparisonCatalog(pkg));
            }
            const result = await runComparisonReport(pkg, reportName, filters);
            const artifact = queryArtifactContext(extra?.requestInfo?.headers);
            const metadata = artifact
               ? await persistQueryArtifact(artifact, result.payload)
               : undefined;
            return jsonResource(uri, { ...result.payload, ...metadata });
         } catch (error) {
            logger.warn("[MCP Tool comparisonReport] report failed", {
               environmentName,
               packageName,
               reportName,
               error: error instanceof Error ? error.message : String(error),
            });
            return jsonToolError(
               uri,
               classifyToolError(
                  "runComparisonReport",
                  `${environmentName}/${packageName}/${reportName}`,
                  error,
               ),
            );
         }
      },
   );
}
