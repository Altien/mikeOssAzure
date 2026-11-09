/** Turn-local edit serialization; database version/claim fences remain mandatory. */
export type KeyedLock = {
  /**
   * Resolves to the release function. Dev's optional `signal` rejects the wait
   * on abort; the dispatcher uses the `*UnlessAborted` forms below.
   */
  acquire(key: string, signal?: AbortSignal): Promise<() => void>;
  run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /**
   * Like `acquire`, but resolves to null instead if `signal` aborts while
   * waiting. The place in line is then handed on as soon as it is reached, so
   * the calls queued behind keep their order.
   */
  acquireUnlessAborted(
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<(() => void) | null>;
  /** Like `run`, but resolves to null without running `fn` if `signal` aborts while waiting. */
  runUnlessAborted<T>(
    key: string,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T | null>;
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
  const acquireUnlessAborted = async (
    key: string,
    signal: AbortSignal | undefined,
  ) => {
    const pending = acquire(key);
    if (!signal) return pending;
    let onAbort = () => {};
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    const release = await Promise.race([pending, aborted]);
    signal.removeEventListener("abort", onAbort);
    if (release && !signal.aborted) return release;
    void pending.then((handOn) => handOn());
    return null;
  };
  return {
    acquire,
    async run(key, fn, signal) {
      const release = await acquire(key, signal);
      try { signal?.throwIfAborted(); return await fn(); }
      finally { release(); }
    },
    acquireUnlessAborted,
    async runUnlessAborted(key, signal, fn) {
      const release = await acquireUnlessAborted(key, signal);
      if (!release) return null;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
