// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { expect, test, Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { readFile } from "node:fs/promises";
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

   test("picking a dimension returns rows and exports the current result", async ({
      page,
   }) => {
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
      let queryRequests = 0;
      page.on("request", (request) => {
         if (
            request.method() === "POST" &&
            new URL(request.url()).pathname.endsWith("/query")
         ) {
            queryRequests += 1;
         }
      });
      await runQuery.click();

      await expect(page.getByRole("tab", { name: "Results" })).toBeVisible();
      const resultsPanel = page.getByRole("tabpanel", { name: "Results" });
      await expect(resultsPanel).toContainText(
         /Aiden Ali|Aiden Andersson|Aiden Cohen|Aiden Diaz/,
      );

      const csv = page.getByRole("link", { name: "Download CSV" });
      const excel = page.getByRole("button", {
         name: "Download Excel (.xlsx)",
      });
      await expect(csv).toBeVisible();
      await expect(excel).toBeVisible();
      await expect(csv).toHaveAttribute("download", /\.csv$/);
      expect(queryRequests).toBe(1);

      const downloadPromise = page.waitForEvent("download");
      await excel.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe("malloy.xlsx");
      const downloadPath = await download.path();
      expect(downloadPath).not.toBeNull();
      const workbook = await readFile(downloadPath!);
      expect(workbook.subarray(0, 4)).toEqual(
         Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      );
      expect(
         strFromU8(unzipSync(workbook)["xl/worksheets/sheet1.xml"]),
      ).toContain(
         '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
      );
      expect(queryRequests).toBe(1);

      await page.getByRole("tab", { name: "Malloy" }).click();
      await expect(excel).not.toBeVisible();
   });
});
