// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

export type OAuthConfig = {
   issuer: string;
   clientId: string;
   scopes: string[];
   redirectUri: string;
};

export type PublisherRuntimeConfig = { oauth?: OAuthConfig };

type Discovery = {
   issuer: string;
   authorization_endpoint: string;
   token_endpoint: string;
};

type PendingAuthorization = {
   state: string;
   verifier: string;
   returnPath: string;
   createdAt: number;
};

const STORAGE_KEY = "publisher:oauth-pending";
const MAX_PENDING_AGE_MS = 10 * 60 * 1000;
const EXPIRY_SKEW_MS = 30 * 1000;

declare global {
   interface Window {
      __MALLOY_PUBLISHER_CONFIG__?: PublisherRuntimeConfig;
   }
}

function base64Url(bytes: Uint8Array): string {
   return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
}

function randomValue(bytes = 32): string {
   return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function normalizeIssuer(issuer: string): string {
   return issuer.replace(/\/+$/, "");
}

async function discover(config: OAuthConfig): Promise<Discovery> {
   const response = await fetch(
      `${normalizeIssuer(config.issuer)}/.well-known/openid-configuration`,
   );
   if (!response.ok) throw new Error("Unable to load sign-in configuration.");
   const discovery = (await response.json()) as Discovery;
   if (
      normalizeIssuer(discovery.issuer) !== normalizeIssuer(config.issuer) ||
      !discovery.authorization_endpoint ||
      !discovery.token_endpoint
   ) {
      throw new Error("The sign-in configuration does not match this site.");
   }
   return discovery;
}

export async function createAuthorizationRequest(
   config: OAuthConfig,
   discovery: Discovery,
   returnPath: string,
   now = Date.now(),
): Promise<{ url: string; pending: PendingAuthorization }> {
   const verifier = randomValue(64);
   const state = randomValue();
   const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
   );
   const url = new URL(discovery.authorization_endpoint);
   url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(" "),
      state,
      code_challenge: base64Url(new Uint8Array(digest)),
      code_challenge_method: "S256",
   }).toString();
   return {
      url: url.toString(),
      pending: { state, verifier, returnPath, createdAt: now },
   };
}

export function validateCallback(
   params: URLSearchParams,
   pending: PendingAuthorization | undefined,
   now = Date.now(),
): { code: string; pending: PendingAuthorization } {
   const denied = params.get("error");
   if (denied) {
      throw new Error(
         params.get("error_description") || `Sign-in failed: ${denied}`,
      );
   }
   const code = params.get("code");
   const state = params.get("state");
   if (!code || !state || !pending || state !== pending.state) {
      throw new Error("The sign-in response state is invalid.");
   }
   if (
      pending.createdAt > now ||
      now - pending.createdAt > MAX_PENDING_AGE_MS
   ) {
      throw new Error("The sign-in response has expired.");
   }
   return { code, pending };
}

async function exchangeCode(
   config: OAuthConfig,
   discovery: Discovery,
   code: string,
   verifier: string,
): Promise<{ accessToken: string; expiresAt: number }> {
   const response = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
         grant_type: "authorization_code",
         client_id: config.clientId,
         redirect_uri: config.redirectUri,
         code,
         code_verifier: verifier,
      }),
   });
   if (!response.ok) throw new Error("Sign-in token exchange failed.");
   const token = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
   };
   if (!token.access_token || !token.expires_in || token.expires_in <= 0) {
      throw new Error("The sign-in server returned an invalid access token.");
   }
   return {
      accessToken: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
   };
}

async function beginAuthorization(
   config: OAuthConfig,
   discovery: Discovery,
): Promise<never> {
   const returnPath = `${location.pathname}${location.search}${location.hash}`;
   const request = await createAuthorizationRequest(
      config,
      discovery,
      returnPath,
   );
   sessionStorage.setItem(STORAGE_KEY, JSON.stringify(request.pending));
   location.replace(request.url);
   return new Promise(() => undefined);
}

export async function initializeOAuth(
   config = window.__MALLOY_PUBLISHER_CONFIG__?.oauth,
): Promise<(() => Promise<string>) | undefined> {
   if (!config) return undefined;
   const discovery = await discover(config);
   const params = new URL(location.href).searchParams;
   if (!params.has("code") && !params.has("error")) {
      return beginAuthorization(config, discovery);
   }

   const stored = sessionStorage.getItem(STORAGE_KEY);
   sessionStorage.removeItem(STORAGE_KEY);
   const pending = stored
      ? (JSON.parse(stored) as PendingAuthorization)
      : undefined;
   const callback = validateCallback(params, pending);
   const token = await exchangeCode(
      config,
      discovery,
      callback.code,
      callback.pending.verifier,
   );
   history.replaceState({}, "", callback.pending.returnPath);

   return async () => {
      if (Date.now() >= token.expiresAt - EXPIRY_SKEW_MS) {
         return beginAuthorization(config, discovery);
      }
      return `Bearer ${token.accessToken}`;
   };
}
