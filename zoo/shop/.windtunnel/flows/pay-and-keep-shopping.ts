import { flow } from "windtunnel";

// Fill the cart and pay. Under a `second-tab` perturbation at "checkout", the second tab keeps
// shopping instead of paying: it adds another product while the first tab pays.
//   params.products  what goes in the cart, one step each (default ["Ceramic Mug"])
//   params.extra     product the second tab adds (default "Wool Socks")
export default flow(async ({ page, step, login, params, tab }) => {
  const products: string[] = params.products ?? ["Ceramic Mug"];
  const extra: string = params.extra ?? "Wool Socks";
  const shopping = tab.includes("#");
  const add = async (name: string) => {
    await page.goto("/");
    const card = page.locator(".card", { has: page.getByRole("heading", { name }) });
    await card.getByRole("button", { name: "Add to cart" }).click();
    await card.getByText("Added").waitFor();
  };
  await login();

  for (const [i, name] of products.entries()) await step(`add-item-${i + 1}`, () => add(name));

  await step("open-cart", () => page.goto("/cart"));

  await step("checkout", () => (shopping ? add(extra) : page.getByRole("button", { name: "Pay now" }).click()));

  await step("confirmation", async () => {
    if (!shopping) await page.getByText("Order confirmed").waitFor();
  });
});
