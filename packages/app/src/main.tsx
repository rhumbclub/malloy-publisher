// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import * as React from "react";
import * as ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { createMalloyRouter } from "./App";
import { BrowserWorkbookStorage } from "@malloy-publisher/sdk";
import { initializeOAuth } from "./oauth";

// Main.tsx is used to run the app locally. This is not used when the app is
// embedded in another project.
const root = ReactDOM.createRoot(document.getElementById("root")!);

try {
   const getAccessToken = await initializeOAuth();
   const router = createMalloyRouter(
      "/",
      new BrowserWorkbookStorage(),
      undefined,
      getAccessToken,
   );
   root.render(
      <React.StrictMode>
         <RouterProvider router={router} />
      </React.StrictMode>,
   );
} catch (error) {
   root.render(
      <main role="alert" style={{ fontFamily: "sans-serif", padding: "2rem" }}>
         <h1>Unable to sign in</h1>
         <p>{error instanceof Error ? error.message : "Sign-in failed."}</p>
      </main>,
   );
}
