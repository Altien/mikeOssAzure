import { describe, expect, it } from "vitest";
import { buildUserAccountExport } from "../userDataExport";

type Row = Record<string, unknown>;

// Read-only fake supporting the query subset buildUserAccountExport uses
// (select/range/eq/neq/in/order/filter + thenable).
function makeDb(tables: Record<string, Row[]>) {
    const reads: string[] = [];
    function query(table: string) {
        let rows = [...(tables[table] ?? [])];
        const builder: any = {
            select: () => builder,
            range: () => builder,
            order: () => builder,
            limit: () => builder,
            eq: (col: string, val: unknown) => {
                rows = rows.filter((r) => r[col] === val);
                return builder;
            },
            neq: (col: string, val: unknown) => {
                rows = rows.filter((r) => r[col] !== val);
                return builder;
            },
            is: (col: string, val: unknown) => {
                rows = rows.filter((r) => (r[col] ?? null) === val);
                return builder;
            },
            not: (col: string, op: string, val: unknown) => {
                if (op === "is" && val === null)
                    rows = rows.filter((r) => (r[col] ?? null) !== null);
                return builder;
            },
            in: (col: string, vals: unknown[]) => {
                rows = rows.filter((r) => vals.includes(r[col]));
                return builder;
            },
            filter: (col: string, op: string, value: string) => {
                reads.push(`${table}.${col}:${op}`);
                if (op !== "cs") return builder;
                const expected = JSON.parse(value) as string[];
                rows = rows.filter((r) => {
                    const actual = r[col];
                    return (
                        Array.isArray(actual) &&
                        expected.every((item) => actual.includes(item))
                    );
                });
                return builder;
            },
            maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
            single: async () => ({ data: rows[0] ?? null, error: null }),
            then: (
                resolve: (v: { data: Row[]; error: null }) => unknown,
                reject?: (e: unknown) => unknown,
            ) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
        };
        return builder;
    }
    return { db: { from: (t: string) => query(t) } as any, reads };
}

describe("account export: shared projects", () => {
    const tables = {
        projects: [
            { id: "own-p", user_id: "u1", name: "Mine", created_at: "1" },
            {
                id: "granted-p",
                user_id: "u2",
                name: "Granted",
                created_at: "2",
            },
            {
                id: "unshared-p",
                user_id: "u2",
                name: "Unshared",
                created_at: "3",
            },
        ],
        project_access_grants: [
            { project_id: "granted-p", email: "u1@example.com", role: "viewer" },
        ],
        tabular_reviews: [],
        chats: [],
        audit_events: [],
        documents: [],
        user_profiles: [],
    };

    it("lists exactly the grant-reachable projects", async () => {
        const { db, reads } = makeDb(tables);
        const exported = await buildUserAccountExport(db, "u1", "u1@example.com");
        const shared = (exported as any).shared_access.projects as Row[];
        expect(shared.map((p) => p.id)).toEqual(["granted-p"]);
        expect(reads.filter((r) => r.startsWith("projects."))).toEqual([]);
    });
});
