import { flow } from "windtunnel";

// A staff member changes a product's price.
//   params.product     product name (default "Ceramic Mug")
//   params.price       new price in cents (default 1500)
//   params.mayConflict finishing with "someone else changed this product" also counts as done
export default flow(async ({ page, step, login, params }) => {
  const product: string = params.product ?? "Ceramic Mug";
  await login();

  await step("open-editor", async () => {
    await page.goto("/admin/products");
    await page.getByRole("link", { name: product }).click();
    await page.getByRole("heading", { name: `Edit ${product}` }).waitFor();
  });

  await step("edit", () => page.getByLabel("Price in cents").fill(String(params.price ?? 1500)));

  await step("save", async () => {
    await page.getByRole("button", { name: "Save" }).click();
    const saved = page.getByText("Saved");
    await (params.mayConflict ? saved.or(page.getByText(/Someone else changed this product/)) : saved).waitFor();
  });
});
