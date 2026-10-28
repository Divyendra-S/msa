import { flow } from "windtunnel";

// Buy one product: add it to the cart, pay, and wait for the order to be confirmed.
//   params.product      product name (default "Ceramic Mug")
//   params.mayBeSoldOut finishing with "out of stock" also counts as done
export default flow(async ({ page, step, login, params }) => {
  const product: string = params.product ?? "Ceramic Mug";
  await login();

  await step("add-item", async () => {
    await page.goto("/");
    const card = page.locator(".card", { has: page.getByRole("heading", { name: product }) });
    await card.getByRole("button", { name: "Add to cart" }).click();
    await card.getByText("Added").waitFor();
  });

  await step("open-cart", () => page.goto("/cart"));

  await step("pay", () => page.getByRole("button", { name: "Pay now" }).click());

  await step("confirmation", async () => {
    const confirmed = page.getByText("Order confirmed");
    await (params.mayBeSoldOut ? confirmed.or(page.getByText(/is out of stock/)) : confirmed).waitFor();
  });
});
