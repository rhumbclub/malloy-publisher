// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { bigIntReplacer } from "../json_utils";

export const MCP_PREVIEW_ROWS = 1000;
const QUERY_ID = /^qr_[1-9A-HJ-NP-Za-km-z]{22}$/;
const PRINCIPAL_HASH = /^[a-f0-9]{16}$/;

export interface QueryArtifactContext {
   requestId: string;
   key: string;
   bucket: string;
   url: string;
}

export interface QueryArtifactMetadata {
   _request_id: string;
   _result_url: string;
   _result_rows: number;
   _preview_row_limit: number;
   _preview_truncated: boolean;
}

type Headers = Record<string, string | string[] | undefined>;

function one(headers: Headers, name: string): string | undefined {
   const value = headers[name];
   return Array.isArray(value) ? value[0] : value;
}

export function queryArtifactContext(
   headers: Headers = {},
   env: NodeJS.ProcessEnv = process.env,
): QueryArtifactContext | null {
   const requestId = one(headers, "x-rhumbclub-query-id");
   if (!requestId) return null;
   if (!QUERY_ID.test(requestId)) throw new Error("Invalid MCP query id header");
   const principal = one(headers, "x-rhumbclub-principal-hash");
   if (!principal || !PRINCIPAL_HASH.test(principal)) {
      throw new Error("Invalid MCP principal header");
   }
   const bucket = env.MCP_QUERY_RESULTS_BUCKET?.trim();
   const baseUrl = env.MCP_QUERY_RESULTS_URL?.trim();
   if (!bucket || !baseUrl) throw new Error("MCP query artifact storage is not configured");
   const url = new URL(`${baseUrl.replace(/\/$/, "")}/${requestId}`);
   if (url.protocol !== "https:") throw new Error("MCP query result URL must use HTTPS");
   return {
      requestId,
      key: `results/${principal}/${requestId}.json`,
      bucket,
      url: url.href,
   };
}

export async function persistQueryArtifact(
   context: QueryArtifactContext,
   result: { rows: unknown },
   s3: Pick<S3Client, "send"> = new S3Client({}),
): Promise<QueryArtifactMetadata> {
   const rows = Array.isArray(result.rows) ? result.rows : [];
   const previewRows = Math.min(rows.length, MCP_PREVIEW_ROWS);
   const metadata = {
      _request_id: context.requestId,
      _result_url: context.url,
      _result_rows: rows.length,
      _preview_row_limit: MCP_PREVIEW_ROWS,
      _preview_truncated: rows.length > previewRows,
   };
   await s3.send(
      new PutObjectCommand({
         Bucket: context.bucket,
         Key: context.key,
         Body: JSON.stringify({ ...result, ...metadata }, bigIntReplacer),
         ContentType: "application/json",
         CacheControl: "private, no-store",
      }),
   );
   return metadata;
}
