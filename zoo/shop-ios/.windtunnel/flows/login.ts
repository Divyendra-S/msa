import { phoneFlow } from "windtunnel";

// How a test user logs in on the phone. `login()` in other flows runs this.
export default phoneFlow(async ({ ui, user }) => {
  await ui.fill("Email", user.email);
  await ui.fill("Password", user.password);
  await ui.tap("Log in");
  await ui.see("Products");
});
