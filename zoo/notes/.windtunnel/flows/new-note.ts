import { flow } from "windtunnel";

// Starts a new note.
export default flow(async ({ page, step }) => {
  await step("open", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Groceries" }).waitFor();
  });

  await step("new", async () => {
    await page.getByRole("button", { name: "New note" }).click();
    await page.getByRole("button", { name: "Untitled" }).first().waitFor();
    await page.getByLabel("Note", { exact: true }).waitFor();
  });
});
