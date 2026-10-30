// The API flow files use: `import { flow } from "windtunnel"` (`phoneFlow` for apps on a phone).
// Kept free of runtime dependencies, because it is loaded into flow files on their own.
import type { Clock, Page } from "playwright";

export interface TestUser {
  /** The user's key in `windtunnel.config.yaml` (e.g. `alice`). */
  name: string;
  email: string;
  password: string;
}

export interface FlowContext {
  /** This tab's page. Its `baseURL` is the branch's app, so `page.goto("/cart")` works. */
  page: Page;
  /**
   * A named step. Perturbations, races and webhook timing attach to step names,
   * and each step ends only once the network is quiet again.
   */
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
  /** Logs this tab in (as its own user unless another is named), using `flows/login.ts`. */
  login(user?: string): Promise<void>;
  /** The user this tab runs as. In `flows/login.ts`, the user being logged in. */
  user: TestUser;
  /** Every user from the config. */
  users: Record<string, TestUser>;
  /** `params` from the experiment file. */
  params: Readonly<Record<string, any>>;
  baseUrl: string;
  /** This tab's label: the user name, plus `#2`, `#3`… for extra tabs of the same session. */
  tab: string;
  clock: Clock;
}

export type FlowFunction = (ctx: FlowContext) => Promise<void>;

/**
 * The app on a phone, found by what the user reads: a control's text or accessibility label
 * (`contentDescription`), a field's label. Each call waits up to `timeout` ms (default 10 s).
 */
export interface PhoneUi {
  /** Taps the control labelled `label`, once it is on screen and enabled. */
  tap(label: string, options?: { timeout?: number }): Promise<void>;
  /** Replaces what the field labelled `label` holds with `value`. */
  fill(label: string, value: string, options?: { timeout?: number }): Promise<void>;
  /** Waits until matching text is on screen (a string matches any text containing it, ignoring case); returns that text. */
  see(text: string | RegExp, options?: { timeout?: number }): Promise<string>;
  /** Whether matching text is on screen right now. */
  shows(text: string | RegExp): Promise<boolean>;
  /** Presses the system Back button. */
  back(): Promise<void>;
  /** Everything on screen as text, top to bottom. */
  text(): Promise<string>;
}

/** What a phone flow gets: the same as a web flow, with the app's screen (`ui`) in place of a page. */
export interface PhoneFlowContext extends Omit<FlowContext, "page" | "clock"> {
  ui: PhoneUi;
}

export type PhoneFlowFunction = (ctx: PhoneFlowContext) => Promise<void>;

export interface Flow {
  readonly kind: "windtunnel.flow";
  /** What the flow drives: a page (web and Tauri apps) or a phone (Android). */
  readonly surface: "page" | "phone";
  /** A phone flow is called with a PhoneFlowContext in its place. */
  readonly run: FlowFunction;
}

/** Defines a flow: a deterministic Playwright script for one user journey, split into named steps. */
export function flow(run: FlowFunction): Flow {
  return { kind: "windtunnel.flow", surface: "page", run };
}

/** Defines a flow for an app on a phone: `ui.tap("Pay now")`, `ui.see("Order confirmed")`, in named steps. */
export function phoneFlow(run: PhoneFlowFunction): Flow {
  return { kind: "windtunnel.flow", surface: "phone", run: run as unknown as FlowFunction };
}

export function isFlow(value: unknown): value is Flow {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Flow).kind === "windtunnel.flow" &&
    typeof (value as Flow).run === "function"
  );
}
