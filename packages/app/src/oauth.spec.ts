// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "bun:test";
import { createAuthorizationRequest, validateCallback } from "./oauth";

const config = {
   issuer: "https://sso.example.test/application/o/publisher/",
   clientId: "publisher",
   scopes: ["openid", "profile", "data:read"],
   redirectUri: "https://publisher.example.test/",
};
const discovery = {
   issuer: config.issuer,
   authorization_endpoint: `${config.issuer}authorize/`,
   token_endpoint: `${config.issuer}token/`,
};

describe("Publisher OAuth PKCE", () => {
   it("creates an S256 request that preserves a deep link", async () => {
      const request = await createAuthorizationRequest(
         config,
         discovery,
         "/uat/governed/model.malloy?x=1#query",
         100,
      );
      const url = new URL(request.url);

      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("scope")).toBe("openid profile data:read");
      expect(request.pending.returnPath).toBe(
         "/uat/governed/model.malloy?x=1#query",
      );
      expect(request.pending.verifier).not.toBe(
         url.searchParams.get("code_challenge"),
      );
   });

   it("accepts a matching callback and rejects mismatch, denial, and expiry", () => {
      const pending = {
         state: "expected",
         verifier: "verifier",
         returnPath: "/deep-link",
         createdAt: 1_000,
      };
      expect(
         validateCallback(
            new URLSearchParams("code=code&state=expected"),
            pending,
            2_000,
         ),
      ).toEqual({ code: "code", pending });
      expect(() =>
         validateCallback(
            new URLSearchParams("code=code&state=wrong"),
            pending,
            2_000,
         ),
      ).toThrow(/state is invalid/);
      expect(() =>
         validateCallback(
            new URLSearchParams("error=access_denied"),
            pending,
            2_000,
         ),
      ).toThrow(/access_denied/);
      expect(() =>
         validateCallback(
            new URLSearchParams("code=code&state=expected"),
            pending,
            1_000 + 10 * 60 * 1000 + 1,
         ),
      ).toThrow(/expired/);
   });
});
