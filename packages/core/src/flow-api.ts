// The API flow files use: `import { flow } from "windtunnel"`.
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

export interface Flow {
  readonly kind: "windtunnel.flow";
  readonly run: FlowFunction;
}

/** Defines a flow: a deterministic Playwright script for one user journey, split into named steps. */
export function flow(run: FlowFunction): Flow {
  return { kind: "windtunnel.flow", run };
}

export function isFlow(value: unknown): value is Flow {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Flow).kind === "windtunnel.flow" &&
    typeof (value as Flow).run === "function"
  );
}
