import type { Page } from "playwright";

/** A user action a flow performs (click, fill, goto…), routed through the tab so perturbations can change it. */
export interface ActionCall {
  method: string;
  /** e.g. `getByRole('button', { name: 'Pay now' })`, or `page` / `keyboard`. */
  target: string;
  args: unknown[];
  /** Index of the options argument for click-like methods. */
  optionsIndex: number;
  invoke(args?: unknown[]): Promise<unknown>;
  /** The action done twice before the app can react (a phone's double tap), where the client has its own way. */
  double?(): Promise<unknown>;
}

export type ActionHook = (call: ActionCall) => Promise<unknown>;

const ACTIONS = new Set([
  "check",
  "clear",
  "click",
  "dblclick",
  "dragTo",
  "fill",
  "goBack",
  "goForward",
  "goto",
  "hover",
  "press",
  "pressSequentially",
  "reload",
  "selectOption",
  "setChecked",
  "setInputFiles",
  "tap",
  "type",
  "uncheck",
]);

interface Classes {
  locator: Function;
  frameLocator: Function;
  keyboard: Function;
  mouse: Function;
}

/**
 * Wraps a page so every action on it, its locators and its keyboard/mouse goes
 * through `hook`. Playwright's class names are minified, so the classes are taken
 * from the live page.
 */
export function instrumentPage(page: Page, hook: ActionHook): Page {
  const classes: Classes = {
    locator: page.locator("html").constructor,
    frameLocator: page.frameLocator("html").constructor,
    keyboard: page.keyboard.constructor,
    mouse: page.mouse.constructor,
  };
  const proxies = new WeakMap<object, object>();
  const originals = new WeakMap<object, object>();

  const unwrap = (value: unknown) =>
    typeof value === "object" && value !== null ? (originals.get(value) ?? value) : value;

  const kindOf = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    if (value instanceof classes.locator) return "locator";
    if (value instanceof classes.frameLocator) return "frameLocator";
    if (value instanceof classes.keyboard) return "keyboard";
    if (value instanceof classes.mouse) return "mouse";
    return undefined;
  };

  const wrap = <T extends object>(target: T, kind: string): T => {
    const existing = proxies.get(target);
    if (existing) return existing as T;
    const proxy = new Proxy(target, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop, obj) as unknown;
        if (typeof value !== "function") {
          const k = kindOf(value);
          return k ? wrap(value as object, k) : value;
        }
        const fn = value as (...a: unknown[]) => unknown;
        return (...args: unknown[]) => {
          const raw = args.map(unwrap);
          if (typeof prop === "string" && ACTIONS.has(prop)) {
            return hook({
              method: prop,
              target: kind === "locator" ? String(obj) : kind,
              args: raw,
              optionsIndex: kind === "page" ? 1 : kind === "mouse" ? 2 : 0,
              invoke: (a = raw) => fn.apply(obj, a) as Promise<unknown>,
            });
          }
          const result = fn.apply(obj, raw);
          if (prop === "all" && result instanceof Promise) {
            return result.then((list: unknown[]) => list.map((item) => wrapIfKnown(item)));
          }
          return wrapIfKnown(result);
        };
      },
    });
    proxies.set(target, proxy);
    originals.set(proxy, target);
    return proxy;
  };

  const wrapIfKnown = (value: unknown) => {
    const kind = kindOf(value);
    return kind ? wrap(value as object, kind) : value;
  };

  return wrap(page, "page");
}

/** Short text for an action, for step records: `click getByRole('button', { name: 'Pay now' })`. */
export function describeAction(call: ActionCall): string {
  const first = call.args[0];
  // keyboard.type / insertText take the typed text, which may be a password.
  const showArg = typeof first === "string" && (call.target !== "keyboard" || call.method === "press");
  const arg = showArg ? ` ${JSON.stringify(first.length > 60 ? `${first.slice(0, 57)}…` : first)}` : "";
  if (call.target === "phone") return call.method;
  if (call.target === "page" || call.target === "keyboard" || call.target === "mouse") {
    return `${call.target === "page" ? "" : `${call.target}.`}${call.method}${arg}`;
  }
  // fill/press/type: the value matters less than the target, and may be a password.
  return `${call.method} ${call.target}`;
}
