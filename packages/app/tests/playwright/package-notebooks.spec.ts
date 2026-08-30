// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { readFile } from "node:fs/promises";
import { DEFAULT_ENV, PACKAGES } from "./helpers/fixtures";
import { gotoHome, openEnvironment, openPackage } from "./helpers/navigation";

test.describe("package-notebooks", () => {
   test("Notebooks section lists .malloynb files", async ({ page }) => {
      await gotoHome(page);
      await openEnvironment(page, DEFAULT_ENV);
      await openPackage(page, DEFAULT_ENV, PACKAGES.storefront);

      // The section label is the only user-visible string the Pages/Console
      // rename changes, and no other test reads it, so a relabel that misses a
      // surface leaves the suite green. Assert the heading before the absence
      // check: toHaveCount(0) is already satisfied while the page is blank, so
      // on its own it would pin nothing.
      await expect(
         page.getByRole("heading", { name: "Notebooks" }),
      ).toBeVisible();
      await expect(
         page.getByRole("heading", { name: "Governed Reports" }),
      ).toHaveCount(0);

      await expect(
         page.getByText("storefront.malloynb", { exact: true }),
      ).toBeVisible();
   });

   test("opening a notebook routes into the workbook view", async ({
      page,
   }) => {
      await gotoHome(page);
      await openEnvironment(page, DEFAULT_ENV);
      await openPackage(page, DEFAULT_ENV, PACKAGES.storefront);

      await page.getByText("storefront.malloynb", { exact: true }).click();

      // Router uses a workbook-scoped path; assert we navigated off the package route.
      await expect(page).not.toHaveURL(
         new RegExp(`/${DEFAULT_ENV}/${PACKAGES.storefront}/?$`),
      );
      await expect(page).toHaveURL(/storefront\.malloynb/);
   });

   test("workbook renders authored content from the notebook", async ({
      page,
   }) => {
      await gotoHome(page);
      await openEnvironment(page, DEFAULT_ENV);
      await openPackage(page, DEFAULT_ENV, PACKAGES.storefront);
      await page.getByText("storefront.malloynb", { exact: true }).click();
      // The storefront.malloynb renders an authored H1 ("Storefront — a guided
      // tour"): presence confirms the Workbook mounted and executed the notebook.
      await expect(
         page.getByRole("heading", {
            name: "Storefront — a guided tour",
            level: 1,
         }),
      ).toBeVisible();
   });

   test("flat table cells download with notebook headings and table numbers", async ({
      page,
   }) => {
      await page.goto(
         `/${DEFAULT_ENV}/${PACKAGES.storefront}/storefront.malloynb`,
      );
      const excel = page.getByRole("button", {
         name: "Download Excel (.xlsx)",
      });
      await expect(excel).toHaveCount(2);

      const downloadPromise = page.waitForEvent("download");
      await excel.first().click();
      const download = await downloadPromise;
      const now = new Date();
      const localDate = [
         now.getFullYear(),
         String(now.getMonth() + 1).padStart(2, "0"),
         String(now.getDate()).padStart(2, "0"),
      ].join("-");
      expect(download.suggestedFilename()).toBe(
         `storefront-a-guided-tour-top-products-and-customers-table-1-${localDate}.xlsx`,
      );
      const workbook = await readFile((await download.path())!);
      expect(
         strFromU8(unzipSync(workbook)["xl/worksheets/sheet1.xml"]),
      ).toContain(
         '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
      );
   });

   test("clicking a notebook row keeps the package segment in the URL", async ({
      page,
   }) => {
      await gotoHome(page);
      await openEnvironment(page, DEFAULT_ENV);
      await openPackage(page, DEFAULT_ENV, PACKAGES.governed);

      // orders.malloynb shares no name overlap with the governed-analytics
      // package, so a dropped package segment lands on /examples/orders.malloynb
      // and 404s. The storefront.malloynb case above cannot catch that (the
      // URL still matches either way).
      await page.getByText("orders.malloynb", { exact: true }).click();

      await expect(page).toHaveURL(
         new RegExp(`/${DEFAULT_ENV}/${PACKAGES.governed}/orders\\.malloynb$`),
      );
      await expect(page.getByText(/does not exist/i)).toHaveCount(0);
   });
});
