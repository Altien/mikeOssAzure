/** Turn-local edit serialization; database version/claim fences remain mandatory. */
export type KeyedLock = {
  acquire(key: string, signal?: AbortSignal): Promise<() => void>;
  run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
};

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<void>>();
  const acquire = async (key: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => released);
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    let onAbort: (() => void) | undefined;
    try {
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          onAbort = () => reject(signal.reason ?? new Error("Operation cancelled"));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          void previous.then(resolve, reject);
        });
      } else await previous;
      signal?.throwIfAborted();
      return release;
    } catch (error) {
      release(); // An abandoned waiter cannot strand later edits.
      throw error;
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
  return {
    acquire,
    async run(key, fn, signal) {
      const release = await acquire(key, signal);
      try { signal?.throwIfAborted(); return await fn(); }
      finally { release(); }
    },
  };
}
