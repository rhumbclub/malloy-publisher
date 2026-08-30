// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GivenValue } from "@malloydata/malloy";
import {
   getDefaultQueryRowLimit,
   getMaxQueryRows,
   getQueryTimeoutMs,
} from "../../config";
import { logger } from "../../logger";
import {
   tryAcquireQuerySlot,
   type QuerySlotHandle,
} from "../../query_concurrency";
import { runWithQueryTimeout } from "../../query_timeout";
import { filterPublisherOwnedRenderLogs } from "../../service/dashboard";
import { EnvironmentStore } from "../../service/environment_store";
import { RESTRICTED_CONSTRUCTS, type ErrorDetails } from "../error_messages";
import {
   buildMalloyUri,
   classifyToolError,
   getModelForQuery,
} from "../handler_utils";
import { jsonResource, jsonToolError } from "../tool_response";
import { buildQueryEnvelope } from "../query_envelope";
import { mintCorrelationId } from "../../service/query_metadata";
import { bigIntReplacer } from "../../json_utils";
import { MCP_ERROR_MESSAGES } from "../mcp_constants";
import { hasComparisonReports } from "../../comparison_reports";
import {
   MCP_PREVIEW_ROWS,
   persistQueryArtifact,
   queryArtifactContext,
} from "../query_artifact";

/**
 * Malloy's two ways of saying a name is not in the model's namespace: a bare
 * reference ("Reference to undefined object 'x'") and a name used where the
 * compiler expected a definition ("'x' is not defined").
 */
function isUndefinedNameError(message: string): boolean {
   return (
      message.includes("is not defined") ||
      message.includes("Reference to undefined object")
   );
}

// Zod shape defining required/optional params for executeQuery
const executeQueryShape = {
   // environmentName is required; other fields mirror SDK expectations
   environmentName: z
      .string()
      .describe(
         "Environment name. Call malloy_getContext with no arguments to list the available environments.",
      ),
   packageName: z
      .string()
      .describe(
         "Package containing the model. Call malloy_getContext with just environmentName to list its packages.",
      ),
   modelPath: z.string().describe("Path to the .malloy model file"),
   query: z
      .string()
      .optional()
      .describe(
         `Ad-hoc Malloy query code. Runs in restricted mode: it may not use ${RESTRICTED_CONSTRUCTS} — put those in a model file and reload instead.`,
      ),
   sourceName: z
      .string()
      .optional()
      .describe(
         "Source name for a view. A NAME, not Malloy code: one name exactly as malloy_getContext returned it, sent bare (the server quotes it, so a hyphen or a reserved word is fine — do not add backticks yourself). Anything richer, such as a parameterized source or an inline extension, goes in query.",
      ),
   queryName: z
      .string()
      .optional()
      .describe(
         "Named query or view. A NAME, not Malloy code, on the same terms as sourceName. To refine a view, put the full statement in query, never queryName: run: source_name -> view_name + { limit: 5000 }.",
      ),
   filterParams: z
      .record(z.union([z.string(), z.array(z.string())]))
      .optional()
      .describe(
         "Filter parameter values keyed by filter name. Used with sources that declare #(filter) annotations.",
      ),
   givens: z
      .record(z.unknown())
      .optional()
      .describe(
         "Per-query given values that override model defaults. Keys are given names declared in the model's given: block.",
      ),
};

function executeQueryDescription(): string {
   const defaultRows = getDefaultQueryRowLimit().toLocaleString("en-US");
   const maxRows = getMaxQueryRows();
   const maximum =
      maxRows > 0
         ? `The hard maximum is ${maxRows.toLocaleString("en-US")} rows.`
         : "No hard maximum is configured.";
   return `Run a Malloy query and return flat JSON rows. Send either Malloy in query or one named view/query in queryName (plus sourceName for a view).

## Contract rules
- Without a query-authored limit:/top:, the server applies a ${defaultRows}-row default. Exactly ${defaultRows} rows sets _limit_hit=true: the result is incomplete.
- To set a larger bound, send Malloy in query: \`run: source_name -> { select: *; limit: 5000 }\`. For a named view: \`run: source_name -> view_name + { limit: 5000 }\`; put the entire refinement in \`query\`, never \`queryName\`.
- ${maximum} A query above it fails; filter or aggregate instead.
- Never calculate a total from returned rows when _limit_hit or _rows_truncated is set. Aggregate in the query.
- _returned_rows=0 with _rows_truncated means a row was too large, not that nothing matched.
- Use names exactly as malloy_getContext returned them. sourceName/queryName accept one name each; put richer Malloy in query.
- query is RESTRICTED: no raw SQL/import/##! (see its param doc).

## Response

- rows: flat objects; _meta: schema, annotations, connection, and timezone.
- _request_id and _result_url: durable query identity and authenticated complete JSON result. Inline rows are a preview capped at ${MCP_PREVIEW_ROWS.toLocaleString("en-US")} when these fields are present.
- A client advertising the stable \`io.modelcontextprotocol/tasks\` extension may receive a durable task handle instead of waiting. Poll \`tasks/get\`; its completed result has this same response shape.
- _query_row_limit, _limit_source, _limit_hit: applied cap, its source, and whether the silent default was reached.
- _rows_truncated, _total_rows, _returned_rows: present only when the payload cap dropped rows.
- _query_id, warning, renderLogErrors: present only when applicable.

Values above 2^53 become JSON strings so their digits survive.`;
}

// Type inference is handled automatically by the MCP server based on the executeQueryShape

/**
 * Registers the malloy_executeQuery tool with the MCP server.
 */
export function registerExecuteQueryTool(
   mcpServer: McpServer,
   environmentStore: EnvironmentStore,
): void {
   mcpServer.tool(
      "malloy_executeQuery",
      executeQueryDescription(),
      executeQueryShape,
      /** Handles requests for the malloy_executeQuery tool */
      async (params, extra) => {
         // Destructure environmentName as well
         const {
            environmentName,
            packageName,
            modelPath,
            query,
            sourceName,
            queryName,
            filterParams,
            givens,
         } = params;
         const artifact = queryArtifactContext(extra?.requestInfo?.headers);

         const hasAdhocQuery = !!query;
         const hasNamedQuery = !!queryName;

         if (!hasAdhocQuery && !hasNamedQuery) {
            throw new McpError(
               ErrorCode.InvalidParams,
               MCP_ERROR_MESSAGES.MISSING_REQUIRED_PARAMS,
            );
         }
         if (hasAdhocQuery && hasNamedQuery) {
            throw new McpError(
               ErrorCode.InvalidParams,
               MCP_ERROR_MESSAGES.MUTUALLY_EXCLUSIVE_PARAMS,
            );
         }
         // Zod/SDK handles missing required fields (packageName, modelPath) based on the shape

         // --- Get Package and Model ---
         logger.info(
            `[MCP Tool executeQuery] Calling getModelForQuery for ${environmentName}/${packageName}/${modelPath}`,
         );
         const modelResult = await getModelForQuery(
            environmentStore,
            environmentName,
            packageName,
            modelPath,
         );

         // Handle errors during package/model access (e.g., not found, initial compilation)
         if ("error" in modelResult) {
            return jsonToolError(
               "error://executeQuery/modelAccess",
               modelResult.error,
            );
         }

         // --- Execute Query ---
         const { model, environment, pkg } = modelResult;
         if (await hasComparisonReports(pkg)) {
            return jsonToolError(
               buildMalloyUri(
                  {
                     environment: environmentName,
                     package: packageName,
                     resourceType: "models",
                     resourceName: modelPath,
                  },
                  "result",
               ),
               {
                  message:
                     "Comparison packages do not allow ad-hoc or named Malloy queries.",
                  suggestions: [
                     "Use malloy_runComparisonReport for ERP UI comparison.",
                     "Use malloy_getContext and malloy_executeQuery against the governed package for analysis.",
                  ],
               },
            );
         }
         logger.info(
            `[MCP Tool executeQuery] Model found. Proceeding to execute query.`,
         );
         // Per-pod concurrency slot. MCP shares the same slot pool
         // as the HTTP query routes so a hot agent loop can't
         // bypass PUBLISHER_MAX_CONCURRENT_QUERIES. `mcp:executeQuery`
         // is a fixed label so the dashboard can separate MCP load
         // from HTTP route load. Acquisition can throw
         // ServiceUnavailableError; the existing catch below surfaces
         // it as the standard MCP error-content payload.
         let querySlot: QuerySlotHandle | null = null;
         try {
            querySlot = tryAcquireQuerySlot("mcp:executeQuery");
            // Per-query metadata, built the same way the HTTP query controller
            // builds it: MCP is a query boundary like any other, and a
            // connection's enforced properties describe the deployment rather
            // than the protocol a query arrived over.
            const queryMetadataInput = {
               environment: environmentName,
               // Minted here because the envelope below returns it.
               correlationId: mintCorrelationId(),
               // The package owns its manifest, so the least-specific
               // author-declared layer is read here; the model knows only its
               // own file and its package's NAME.
               packageDeclaration: pkg.getDeclaredQueryMetadata(),
               // The environment owns the connection configs, so the default
               // and enforced layers are read here rather than from the model.
               connectionMetadata: (connectionName: string) => {
                  try {
                     const connection =
                        environment.getApiConnection(connectionName);
                     return {
                        default: connection.queryMetadata,
                        enforced: connection.queryMetadataEnforced,
                     };
                  } catch (error) {
                     logger.debug(
                        "[MCP Tool executeQuery] No query-metadata layers for connection",
                        { connectionName, error },
                     );
                     return null;
                  }
               },
            };
            // The two call modes differ only in which arguments carry the
            // query; everything after the run is identical, so they share one
            // path rather than two copies that can drift.
            const {
               result,
               compactResult,
               rowLimit,
               rowLimitSource,
               queryCorrelationId,
            } = await runWithQueryTimeout(
               (abortSignal) =>
                  query
                     ? model.getQueryResults(
                          undefined,
                          undefined,
                          query,
                          filterParams,
                          undefined,
                          givens as Record<string, GivenValue> | undefined,
                          abortSignal,
                          queryMetadataInput,
                          // The envelope below is built from `compactResult`, so
                          // that is the shape to cap and to guard. Left at the
                          // default this measured the full wrapped result and
                          // threw the string away, which meant a query could be
                          // refused on bytes the agent would never receive: the
                          // envelope is truncated to MAX_RESULT_CHARS anyway, so
                          // a wrapped result measuring over the cap was a 413 for
                          // a payload that would have arrived at 90k characters.
                          "compact",
                          false,
                          artifact && getMaxQueryRows() > 0
                             ? getMaxQueryRows() + 1
                             : undefined,
                       )
                     : model.getQueryResults(
                          sourceName,
                          queryName,
                          undefined,
                          filterParams,
                          undefined,
                          givens as Record<string, GivenValue> | undefined,
                          abortSignal,
                          queryMetadataInput,
                          "compact",
                          false,
                          artifact && getMaxQueryRows() > 0
                             ? getMaxQueryRows() + 1
                             : undefined,
                       ),
               getQueryTimeoutMs(),
            );

            // Render-tag validation reads the FULL Malloy result: the tags live
            // in its schema annotations, which the flat rows do not carry. It
            // runs regardless of which shape is returned.
            const { validateRenderTags } = await import(
               "@malloydata/render-validator"
            );
            const renderLogs = filterPublisherOwnedRenderLogs(
               validateRenderTags(result),
            );

            const resultUri = buildMalloyUri(
               {
                  environment: environmentName,
                  package: packageName,
                  resourceType: "models" as const,
                  resourceName: modelPath,
               },
               "result",
            );

            const renderErrors = renderLogs.map((log) => log.message);
            const artifactMetadata = artifact
               ? await persistQueryArtifact(
                    artifact,
                    buildQueryEnvelope(
                       compactResult,
                       rowLimit,
                       result,
                       renderErrors,
                       0,
                       rowLimitSource,
                       queryCorrelationId,
                       getMaxQueryRows(),
                    ),
                 )
               : undefined;
            const preview =
               artifact && Array.isArray(compactResult)
                  ? compactResult.slice(0, MCP_PREVIEW_ROWS)
                  : compactResult;
            const envelope = buildQueryEnvelope(
               preview,
               rowLimit,
               result,
               renderErrors,
               undefined,
               rowLimitSource,
               queryCorrelationId,
               getMaxQueryRows(),
               artifactMetadata,
            );

            // A capped or truncated result, and a broken render tag, are the
            // things an agent most needs to notice, so they are stated in text
            // rather than left for a client that parses the payload.
            const notes = [
               envelope.warning,
               envelope.renderLogErrors &&
                  `Render tag problems: ${envelope.renderLogErrors.join("; ")}`,
            ].filter(Boolean);

            return jsonResource(resultUri, envelope, {
               space: 2,
               // BigInt reaches here: compactResult is raw driver output and
               // DuckDB returns count() as one.
               replacer: bigIntReplacer,
               text: notes.length > 0 ? notes.join("\n\n") : undefined,
            });
         } catch (queryError) {
            // Handle query execution errors (syntax errors, invalid queries, etc.)
            logger.error(
               `[MCP Server Error] Error executing query in ${environmentName}/${packageName}/${modelPath}:`,
               { error: queryError },
            );
            // Home the error by class first. tryAcquireQuerySlot runs inside
            // this try, so at the concurrency cap a ServiceUnavailableError
            // lands here; funnelling that through the Malloy helper told the
            // agent to check its syntax when the answer was to retry.
            const errorDetails: ErrorDetails = classifyToolError(
               "executeQuery",
               `${environmentName}/${packageName}/${modelPath}`, // Include environment
               queryError,
            );

            // A name the model does not define reads as a typo, and the
            // suggestions say so. But the same error is what an author gets
            // after saving a new source or view: the served model is the one
            // compiled at boot, so the name exists on disk and not in memory.
            // Point at the reload rather than let them hunt for a typo that
            // isn't there.
            const suggestions = [...errorDetails.suggestions];
            if (isUndefinedNameError(errorDetails.message)) {
               suggestions.push(
                  "If you added or renamed this source or view on disk after the server loaded the package, the running model is still the one compiled at boot. Call malloy_reloadPackage for this package, then retry.",
               );
            }

            return jsonToolError("error://executeQuery/queryExecution", {
               message: errorDetails.message,
               suggestions,
            });
         } finally {
            // Release on every exit path — success, error, or
            // unreachable code-path throw. `release()` is idempotent
            // so a double-fault during cleanup can't double-decrement.
            querySlot?.release();
         }
      },
   );
}
