import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSchemaVersion } from "./schemaCheck";

function migrationsDir(names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "schema-check-"));
  for (const name of names) writeFileSync(join(dir, `${name}.sql`), "select 1;");
  writeFileSync(join(dir, "UPSTREAM_SYNC_LOG.md"), "# not a migration");
  return dir;
}

function fakeDb(applied: string[] | { error: { message: string } }) {
  return {
    from: () => ({
      select: async () =>
        Array.isArray(applied)
          ? { data: applied.map((name) => ({ name })), error: null }
          : { data: null, error: applied.error },
    }),
  } as never;
}

describe("schema version check", () => {
  it("names every migration the database is missing", async () => {
    const lines: string[] = [];
    const result = await checkSchemaVersion({
      migrationsDir: migrationsDir(["0001_a", "0002_b", "0003_c"]),
      db: fakeDb(["0001_a"]),
      log: (message) => lines.push(message),
    });

    expect(result).toEqual({ pending: ["0002_b", "0003_c"], checked: true });
    const output = lines.join("\n");
    expect(output).toContain("SCHEMA IS BEHIND THIS BUILD");
    expect(output).toContain("0002_b");
    expect(output).toContain("0003_c");
    expect(output).toContain("migrate:local");
  });

  it("says nothing when the schema is current", async () => {
    const lines: string[] = [];
    const result = await checkSchemaVersion({
      migrationsDir: migrationsDir(["0001_a", "0002_b"]),
      db: fakeDb(["0001_a", "0002_b"]),
      log: (message) => lines.push(message),
    });

    expect(result).toEqual({ pending: [], checked: true });
    expect(lines).toEqual([]);
  });

  it("stays quiet when the migration table cannot be read", async () => {
    // A convenience check must never be why a deployment looks broken.
    const result = await checkSchemaVersion({
      migrationsDir: migrationsDir(["0001_a"]),
      db: fakeDb({ error: { message: "relation does not exist" } }),
      log: () => {},
    });
    expect(result).toEqual({ pending: [], checked: false });
  });

  it("does nothing when this build ships no migrations directory", async () => {
    const result = await checkSchemaVersion({
      migrationsDir: join(tmpdir(), "definitely-not-here-schema-check"),
      db: fakeDb([]),
      log: () => {},
    });
    expect(result).toEqual({ pending: [], checked: false });
  });
});
