import { flow } from "windtunnel";

// How a test user logs in. `login()` in other flows runs this.
export default flow(async ({ page, user }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL("/");
});
