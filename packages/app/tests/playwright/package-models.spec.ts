// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { expect, test, Page } from "@playwright/test";
import { DEFAULT_ENV, PACKAGES } from "./helpers/fixtures";
import { gotoHome, openEnvironment, openPackage } from "./helpers/navigation";

// .first() is defensive: the package page yields exactly one exact match for a
// model path today, in the Semantic Models section.
function modelRow(page: Page, name: string) {
   return page.getByText(name, { exact: true }).first();
}

test.describe("package-models", () => {
   test("Semantic Models section lists .malloy files", async ({ page }) => {
      await gotoHome(page);
      await openEnvironment(page, DEFAULT_ENV);
      await openPackage(page, DEFAULT_ENV, PACKAGES.storefront);

      await expect(modelRow(page, "storefront.malloy")).toBeVisible();
   });

   test("opening a model routes to /:env/:pkg/:model and loads Sources", async ({
      page,
   }) => {
      await gotoHome(page);
      await openEnvironment(page, DEFAULT_ENV);
      await openPackage(page, DEFAULT_ENV, PACKAGES.storefront);

      await modelRow(page, "storefront.malloy").click();
      await expect(page).toHaveURL(
         new RegExp(
            `/${DEFAULT_ENV}/${PACKAGES.storefront}/storefront\\.malloy$`,
         ),
      );
      await expect(
         page.getByRole("heading", { name: "Sources", level: 1 }),
      ).toBeVisible();
   });

   test("source combobox defaults to a known source value", async ({
      page,
   }) => {
      await gotoHome(page);
      await openEnvironment(page, DEFAULT_ENV);
      await openPackage(page, DEFAULT_ENV, PACKAGES.storefront);
      await modelRow(page, "storefront.malloy").click();

      // MUI Autocomplete: input value, not innerText.
      await expect(page.getByRole("combobox").first()).toHaveValue("customers");
   });

   test("touch-dragging a divider widens the source panel", async ({
      page,
   }) => {
      await gotoHome(page);
      await openEnvironment(page, DEFAULT_ENV);
      await openPackage(page, DEFAULT_ENV, PACKAGES.storefront);
      await modelRow(page, "storefront.malloy").click();

      const sourcePanel = page.locator(".malloy-explorer-panels > div").first();
      const handle = sourcePanel.locator(":scope > div").last();
      await expect(sourcePanel).toHaveCSS("width", "280px");

      const box = await handle.boundingBox();
      expect(box).not.toBeNull();
      const pointer = {
         pointerId: 1,
         pointerType: "touch",
         isPrimary: true,
         clientY: box!.y + 100,
      };
      await handle.dispatchEvent("pointerdown", {
         ...pointer,
         clientX: box!.x + 4,
         button: 0,
         buttons: 1,
      });
      await handle.dispatchEvent("pointermove", {
         ...pointer,
         clientX: box!.x + 124,
         button: -1,
         buttons: 1,
      });
      await handle.dispatchEvent("pointerup", {
         ...pointer,
         clientX: box!.x + 124,
         button: 0,
         buttons: 0,
      });

      await expect(sourcePanel).toHaveCSS("width", "400px");
   });

   test("picking a dimension and running returns rows", async ({ page }) => {
      await gotoHome(page);
      await openEnvironment(page, DEFAULT_ENV);
      await openPackage(page, DEFAULT_ENV, PACKAGES.storefront);
      await modelRow(page, "storefront.malloy").click();

      const sourceSelect = page.getByRole("combobox").first();
      await expect(sourceSelect).toHaveValue("customers");
      await page.keyboard.press("Escape");

      const dimensionsToggle = page.getByText("Dimensions5");
      await expect(dimensionsToggle).toBeVisible();
      await dimensionsToggle.scrollIntoViewIfNeeded();
      await dimensionsToggle.click();

      const nameField = page.getByText("full_name", { exact: true });
      await expect(nameField).toBeVisible();
      await nameField.scrollIntoViewIfNeeded();
      // force: label sits under an icon button; Playwright otherwise reports pointer interception.
      await nameField.click({ force: true });

      const runQuery = page.getByRole("button", { name: "Run", exact: true });
      await expect(runQuery).toBeEnabled();
      await runQuery.click();

      await expect(page.getByRole("tab", { name: "Results" })).toBeVisible();
      const resultsPanel = page.getByRole("tabpanel", { name: "Results" });
      await expect(resultsPanel).toContainText(
         /Aiden Ali|Aiden Andersson|Aiden Cohen|Aiden Diaz/,
      );
   });
});
