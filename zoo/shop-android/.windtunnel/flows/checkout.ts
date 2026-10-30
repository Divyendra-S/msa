import { phoneFlow } from "windtunnel";

// Buy one product on the phone: add it to the cart, pay, and wait for the order to be confirmed.
// If the app was closed meanwhile and opens on the products again, the user looks in the cart and
// pays again if the items are still there.
//   params.product      product name (default "Ceramic Mug")
//   params.mayBeSoldOut finishing with "out of stock" also counts as done
//   params.mayFail      finishing with an error message (the payment didn't go through) also counts as done
export default phoneFlow(async ({ ui, step, login, params }) => {
  const product: string = params.product ?? "Ceramic Mug";
  const endings = ["Order confirmed", ...(params.mayBeSoldOut ? ["out of stock"] : []), ...(params.mayFail ? ["try again", "failed"] : [])];
  const done = new RegExp(endings.join("|"), "i");
  await login();

  await step("add-item", async () => {
    await ui.tap(`Add ${product} to cart`);
    await ui.see("Added");
  });

  await step("open-cart", async () => {
    await ui.tap("Cart");
    await ui.see("Pay now");
  });

  await step("pay", () => ui.tap("Pay now"));

  await step("confirmation", async () => {
    const seen = await ui.see(new RegExp(`${done.source}|^Products$`, "i"), { timeout: 15_000 });
    if (seen !== "Products") return;
    await ui.tap("Cart");
    if ((await ui.see(/Pay now|Your cart is empty/)) === "Pay now") {
      await ui.tap("Pay now");
      await ui.see(done, { timeout: 15_000 });
    }
  });
});
