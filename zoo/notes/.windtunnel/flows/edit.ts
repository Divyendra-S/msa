import { flow } from "windtunnel";

// Edits a note: types, waits for the autosave to start, types more and presses Save.
//   params.note   the note to open (default "Groceries")
export default flow(async ({ page, step, params }) => {
  const note: string = params.note ?? "Groceries";
  const editor = page.getByLabel("Note", { exact: true });

  await step("open", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: note }).click();
    await editor.waitFor();
  });

  await step("type", async () => {
    await editor.fill(`${note}\nmilk, eggs, bread`);
    // Saving… while the autosave is on its way; Saved if it was quick.
    await page.getByRole("status").getByText(/Saving…|Saved/).waitFor();
  });

  await step("type-more", () => editor.fill(`${note}\nmilk, eggs, bread, butter`));

  await step("save", async () => {
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("status").getByText("Saved").waitFor();
  });
});
