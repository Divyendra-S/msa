import { flow } from "windtunnel";

// Types into a note, then deletes it while the autosave is still on its way.
export default flow(async ({ page, step }) => {
  const editor = page.getByLabel("Note", { exact: true });

  await step("open", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Trip to Lisbon" }).click();
    await editor.waitFor();
  });

  await step("type", async () => {
    await editor.fill("Trip to Lisbon\nbook the flights, find a hotel");
    // Saving… while the autosave is on its way; Saved if it was quick.
    await page.getByRole("status").getByText(/Saving…|Saved/).waitFor();
  });

  await step("delete", async () => {
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("status").getByText("Moved to the trash").waitFor();
  });
});
