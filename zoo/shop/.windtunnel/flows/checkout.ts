import { flow } from "windtunnel";

// Buy one product: add it to the cart, pay, and wait for the order to be confirmed.
// When the app asks to log in again (the session ended), the user does and carries on.
//   params.product      product name (default "Ceramic Mug")
//   params.mayBeSoldOut finishing with "out of stock" also counts as done
export default flow(async ({ page, step, login, params, user }) => {
  const product: string = params.product ?? "Ceramic Mug";
  const isLoginPage = () => new URL(page.url()).pathname === "/login";
  const logInAgain = async () => {
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.waitForURL((url) => url.pathname !== "/login");
  };
  await login();

  await step("add-item", async () => {
    await page.goto("/");
    const card = page.locator(".card", { has: page.getByRole("heading", { name: product }) });
    await card.getByRole("button", { name: "Add to cart" }).click();
    await card.getByText("Added").waitFor();
  });

  await step("open-cart", () => page.goto("/cart"));

  await step("pay", () => page.getByRole("button", { name: "Pay now" }).click());

  if (isLoginPage()) {
    await step("log-in-again", logInAgain);
    await step("pay-again", () => page.getByRole("button", { name: "Pay now" }).click());
  }

  await step("confirmation", async () => {
    const done = page.getByText("Order confirmed");
    const ending = params.mayBeSoldOut ? done.or(page.getByText(/out of stock/)) : done;
    await ending.or(page.getByLabel("Email")).waitFor();
    if (isLoginPage()) {
      await logInAgain();
      await ending.waitFor();
    }
  });
});
