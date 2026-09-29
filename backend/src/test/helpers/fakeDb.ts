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
 * .limit/.range]* awaited directly or via .single()/.maybeSingle(),
 * from(t).insert(payload).select(...), from(t).delete().eq/.in,
 * from(t).update(payload).eq, from(t).upsert(payload, options), and
 * rpc(fn, args) (recorded with table = fn, op "rpc", payload = args).
 *
 * A call is recorded only when it is actually awaited (in `then`), so
 * `calls` reflects executed queries in await order — Promise.all batches
 * record in construction order, which is stable for assertions.
 */

export type DbCall = {
  table: string;
  op: "select" | "insert" | "delete" | "update" | "upsert" | "rpc";
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
        // A trailing .select() after a write (insert/update/upsert
        // ...select().single()) keeps the write's op.
        select(columns?: string) {
          call.columns = columns;
          return builder;
        },
        insert(payload: unknown) {
          call.op = "insert";
          call.payload = payload;
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
        upsert(payload: unknown, options?: unknown) {
          call.op = "upsert";
          call.payload = payload;
          if (options !== undefined) call.filters.push(["options", "", options]);
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
        limit() {
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
    rpc(fn: string, args?: unknown): Promise<DbResult> {
      const call: DbCall = { table: fn, op: "rpc", filters: [], payload: args };
      calls.push(call);
      return Promise.resolve({ data: null, error: null, ...respond(call) });
    },
  };

  /** Executed calls for a table (optionally one op). */
  const callsFor = (table: string, op?: DbCall["op"]) =>
    calls.filter((c) => c.table === table && (!op || c.op === op));

  return { db, calls, callsFor };
}
