import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// backend/schema.sql is run top to bottom on a fresh install.
//
// Postgres checks the body of a `language sql` function when the function is
// created, so one that reads a table or calls a function defined further
// down the file fails the install — and takes with it everything that
// depends on it. A plpgsql body is only checked when it runs, so the same
// mistake there is harmless, which is why it is easy to make: moving a
// function into the "natural" place beside its twin can put it ahead of the
// tables it reads.
//
// Nothing else in `npm test` notices. Migrations apply fine to a database
// that already has those tables, and the fresh-install path is otherwise
// only exercised by the schema-drift workflow. This reads the file the way
// Postgres would and checks the order.
// ---------------------------------------------------------------------------

// Upstream divergence (sync-log: 487e77e3): Dev fresh installs and upgrades
// share the canonical numbered history; workflow tables already precede0117.
const migrationDir = resolve(__dirname, "../../migrations");
const schema = readdirSync(migrationDir)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort()
    .map((name) => readFileSync(resolve(migrationDir, name), "utf8"))
    .join("\n")
    .toLowerCase();

/** Where each table and function is first defined, by name. */
function firstDefinitions(sql: string): Map<string, number> {
    const defined = new Map<string, number>();
    for (const match of sql.matchAll(
        /create (?:table if not exists|or replace function|function) public\.(\w+)\s*\(/g,
    )) {
        if (!defined.has(match[1])) defined.set(match[1], match.index);
    }
    return defined;
}

type SqlFunction = { name: string; at: number; line: number; body: string };

/** Every `language sql` function in the file, with its body. */
function sqlLanguageFunctions(sql: string): SqlFunction[] {
    const found: SqlFunction[] = [];
    for (const match of sql.matchAll(/create or replace function public\.(\w+)\s*\(/g)) {
        // Dev drift: numbered migrations use named dollar tags as well as $$.
        // Bound the header to this function instead of consuming a later body.
        const next = sql.indexOf("create or replace function public.", match.index! + match[0].length);
        const definition = sql.slice(match.index, next < 0 ? undefined : next);
        const delimiter = /\bas\s+(\$[a-z_0-9]*\$)/.exec(definition);
        if (!delimiter || !/\blanguage sql\b/.test(definition.slice(0, delimiter.index))) continue;
        const bodyStart = delimiter.index + delimiter[0].length;
        const bodyEnd = definition.indexOf(delimiter[1], bodyStart);
        if (bodyEnd < 0) continue;
        found.push({ name: match[1], at: match.index!, line: sql.slice(0, match.index).split("\n").length, body: definition.slice(bodyStart, bodyEnd) });
    }
    return found;
}

describe("canonical numbered history can be installed top to bottom", () => {
    const defined = firstDefinitions(schema);
    const functions = sqlLanguageFunctions(schema);

    it("finds the SQL functions it is meant to be checking", () => {
        expect(functions.length).toBeGreaterThan(20);
        expect(functions.map((fn) => fn.name)).toEqual(
            expect.arrayContaining([
                "project_access_role",
                "workflow_is_ownerless",
                "chat_access_role",
            ]),
        );
    });

    it("defines every table and function a SQL function uses before that function", () => {
        const tooEarly = functions.flatMap((fn) =>
            [...new Set([...fn.body.matchAll(/public\.(\w+)/g)].map((m) => m[1]))]
                .filter((used) => used !== fn.name)
                .filter((used) => (defined.get(used) ?? -1) > fn.at)
                .map(
                    (used) =>
                        `${fn.name} (line ${fn.line}) uses public.${used}, which is defined later`,
                ),
        );
        expect(tooEarly).toEqual([]);
    });
});
