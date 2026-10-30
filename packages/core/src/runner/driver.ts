import type { Clock, Page } from "playwright";
import type { ActionHook } from "./instrument.ts";
import type { Group, Network, NetworkTab } from "./network.ts";
import type { PageSnapshot } from "./snapshot.ts";

/** What the user saw when a step ended: where they were and the visible text. */
export interface Seen {
  path: string;
  text: string;
}

/** Where the user was and what the screen said when a flow failed. */
export interface ScreenState {
  path: string;
  /** Texts of alerts on screen. */
  alerts: string[];
  /** The start of the visible text. */
  text: string;
}

/** What a flow drives in one tab: a page and its clock, for web apps. */
export interface FlowSurface {
  page: Page;
  clock: Clock;
}

export interface SessionOptions {
  /** Where the session's calls go: the app, or the proxy in front of it. */
  baseUrl: string;
  /** Install the fake clock, starting here (the experiment's `clock`, or now). */
  clock?: Date;
  /** Record a trace with this title. */
  trace?: string;
  /** Route this session's calls through the network layer itself (the route seam), counting them in `group`. */
  route?: { network: Network; group: Group; tabOf: (label: string) => NetworkTab | undefined };
  /** Name each tab in a header on its calls, for the proxy seam. */
  tagTabs?: boolean;
}

/**
 * How a run drives the app's client: one session per user, each with its tabs. The web driver
 * is a Playwright browser; phones and desktop apps get their own (platforms-plan.md).
 */
export interface Driver {
  session(user: string, options: SessionOptions): Promise<DriverSession>;
}

/** A user's session: the login, cookies and storage its tabs share. */
export interface DriverSession {
  open(label: string, hooks: TabHooks): Promise<DriverTab>;
  /** Forgets the login: every cookie, or the one named. */
  expire(cookie?: string): Promise<void>;
  advanceClock(ms: number): Promise<void>;
  /** Sends a request with the session's login (a replay as this user). */
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: Buffer }): Promise<{ status: number }>;
  /** Stops any trace (saved to `tracePath` when given; true if saved) and closes the session. */
  close(tracePath?: string): Promise<boolean>;
}

export interface TabHooks {
  /** Every user action the flow performs goes through here, so perturbations can change it. */
  onAction: ActionHook;
  /** Errors and warnings the client logged. */
  onConsole(type: string, text: string): void;
}

/** One tab: a page, a window, the app on a phone. */
export interface DriverTab {
  readonly surface: FlowSurface;
  /** The full address of what's on screen. */
  url(): string;
  /** Goes to an address (absolute, or relative to the session's base). */
  open(url: string): Promise<void>;
  reload(): Promise<void>;
  back(): Promise<void>;
  seen(): Promise<Seen | undefined>;
  state(): Promise<ScreenState | undefined>;
  /** The controls and texts on screen, for locator repair. */
  snapshot(): Promise<PageSnapshot | undefined>;
  /** A JPEG of the screen; false when it couldn't be taken in time. */
  screenshot(path: string, options: { quality: number; timeoutMs: number }): Promise<boolean>;
  close(): Promise<void>;
}
