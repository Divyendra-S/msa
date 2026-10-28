export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves with the promise's value, or `false` after `ms`. The timer never outlives the promise. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | false> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
