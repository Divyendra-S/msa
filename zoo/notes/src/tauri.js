// @ts-check
// The two calls the app makes into Tauri, made the way @tauri-apps/api/core and /event make them.

/**
 * @typedef {object} TauriInternals
 * @property {(cmd: string, args?: Record<string, unknown>) => Promise<unknown>} invoke
 * @property {(callback: (data: any) => void, once?: boolean) => number} transformCallback
 */

/** @returns {TauriInternals} */
function internals() {
  return /** @type {any} */ (window).__TAURI_INTERNALS__;
}

/**
 * @template T
 * @param {string} cmd
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<T>}
 */
export function invoke(cmd, args = {}) {
  return /** @type {Promise<T>} */ (internals().invoke(cmd, args));
}

/**
 * @param {string} event
 * @param {(event: { event: string, payload: unknown }) => void} handler
 */
export async function listen(event, handler) {
  const callback = internals().transformCallback(handler);
  await invoke("plugin:event|listen", { event, target: { kind: "Any" }, handler: callback });
}
