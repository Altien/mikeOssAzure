/**
 * Programmable supabase-client fake for lib-level tests.
 *
 * The real client is a fluent builder where the terminal `await` resolves
 * `{ data, error }`. This fake records every operation and routes the
 * result through a single `respond(call)` callback, so a test declares
 * behaviour per table/op instead of hand-building one-off thenables
 * (the route tests' older per-file fakes grew unwieldy for multi-table
 * cascades like userDataCleanup).
 *
 * Supported chains: from(t).select(cols)[.eq/.neq/.in/.is/.filter/.order/
 * .range]* awaited directly or via .single()/.maybeSingle(),
 * from(t).delete().eq/.in, from(t).update(payload).eq.
 *
 * A call is recorded only when it is actually awaited (in `then`), so
 * `calls` reflects executed queries in await order — Promise.all batches
 * record in construction order, which is stable for assertions.
 */

export type DbCall = {
  table: string;
  op: "select" | "delete" | "update";
  /** [method, column, value] tuples in chain order, e.g. ["eq","user_id","u1"] */
  filters: Array<[string, string, unknown]>;
  payload?: unknown;
  columns?: string;
};

export type DbResult = {
  data?: unknown;
  error?: { message: string } | null;
};

export function makeFakeDb(
  respond: (call: DbCall) => DbResult = () => ({ data: [], error: null }),
) {
  const calls: DbCall[] = [];

  const db = {
    from(table: string) {
      const call: DbCall = { table, op: "select", filters: [] };
      let recorded = false;
      const resolve = (): Promise<DbResult> => {
        if (!recorded) {
          recorded = true;
          calls.push(call);
        }
        return Promise.resolve({ data: [], error: null, ...respond(call) });
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select(columns?: string) {
          call.op = "select";
          call.columns = columns;
          return builder;
        },
        delete() {
          call.op = "delete";
          return builder;
        },
        update(payload: unknown) {
          call.op = "update";
          call.payload = payload;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push(["eq", column, value]);
          return builder;
        },
        neq(column: string, value: unknown) {
          call.filters.push(["neq", column, value]);
          return builder;
        },
        in(column: string, values: unknown) {
          call.filters.push(["in", column, values]);
          return builder;
        },
        is(column: string, value: unknown) {
          call.filters.push(["is", column, value]);
          return builder;
        },
        filter(column: string, operator: string, value: unknown) {
          call.filters.push([`filter:${operator}`, column, value]);
          return builder;
        },
        order() {
          return builder;
        },
        range(from: number, to: number) {
          call.filters.push(["range", String(from), to]);
          return builder;
        },
        single: () =>
          resolve().then((r) => ({
            ...r,
            data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
          })),
        maybeSingle: () =>
          resolve().then((r) => ({
            ...r,
            data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
          })),
        then: (
          onFulfilled: (value: DbResult) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => resolve().then(onFulfilled, onRejected),
      };
      return builder;
    },
  };

  /** Executed calls for a table (optionally one op). */
  const callsFor = (table: string, op?: DbCall["op"]) =>
    calls.filter((c) => c.table === table && (!op || c.op === op));

  return { db, calls, callsFor };
}
