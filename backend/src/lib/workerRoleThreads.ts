import type { Worker } from "node:worker_threads";

/** Preserve Dev fail-boot semantics: listen only after every role reports ready. */
export async function startRoleThreads<Role extends string>(roles: readonly Role[], spawn: (role: Role) => Promise<Worker>): Promise<Worker[]> {
  const threads: Worker[] = [];
  try {
    for (const role of roles) threads.push(await spawn(role));
    return threads;
  } catch (error) {
    await Promise.allSettled(threads.map(thread => thread.terminate()));
    throw error;
  }
}
export async function stopRoleThreads(threads: readonly Worker[]): Promise<void> {
  await Promise.all(threads.map(async thread => {
    if (thread.threadId === -1) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exited: (() => void) | undefined;
    try {
      await new Promise<void>(resolve => {
        exited = resolve;
        thread.once("exit", exited);
        timer = setTimeout(resolve, 10_000);
        thread.postMessage("shutdown");
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (exited) thread.off("exit", exited);
      if (thread.threadId !== -1) await thread.terminate();
    }
  }));
}
