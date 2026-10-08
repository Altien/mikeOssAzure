import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareMigrationHistory, migrationFiles, parseMigrationCommand } from "../scripts/migrationLedger";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("numbered migration history", () => {
  it("requires exact filenames and explicit authority for manual recording", () => {
    expect(parseMigrationCommand([])).toEqual({ kind: "up" });
    expect(parseMigrationCommand(["status"])).toEqual({ kind: "status" });
    expect(parseMigrationCommand(["baseline", "0001_example.sql", "--confirm-applied"]))
      .toEqual({ kind: "baseline", filename: "0001_example.sql" });
    for (const args of [
      ["baseline", "0001_example.sql"], ["mark", "../0001_example.sql", "--confirm-applied"],
      ["up", "--confirm-applied"], ["status", "extra"],
    ]) expect(() => parseMigrationCommand(args)).toThrow(/Usage/);
  });

  it("keeps unverified applied files separate from genuinely pending files", () => {
    const files = [
      { name: "0000_initial", filename: "0000_initial.sql", checksum: "a" },
      { name: "0001_next", filename: "0001_next.sql", checksum: "b" },
    ];
    const state = compareMigrationHistory(files, [{ name: "0000_initial", checksum: null }]);
    expect(state.pending.map((file) => file.name)).toEqual(["0001_next"]);
    expect(state.unverified).toEqual(["0000_initial"]);
    expect(state.changed).toEqual([]);
    expect(state.missing).toEqual([]);
  });

  it("detects edited, renamed and inserted historical files", () => {
    const state = compareMigrationHistory([
      { name: "0001_new", filename: "0001_new.sql", checksum: "new" },
      { name: "0002_existing", filename: "0002_existing.sql", checksum: "edited" },
    ], [
      { name: "0000_removed", checksum: "old" },
      { name: "0002_existing", checksum: "original" },
    ]);
    expect(state.changed).toEqual(["0002_existing"]);
    expect(state.missing).toEqual(["0000_removed"]);
    expect(state.outOfOrder).toEqual(["0001_new"]);
  });

  it("hashes the same SQL consistently on Windows and Linux and ignores notes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mike-migrations-")); directories.push(dir);
    const file = path.join(dir, "0000_initial.sql");
    await writeFile(file, "select 1;\n");
    await writeFile(path.join(dir, "UPSTREAM_SYNC_LOG.md"), "not executable");
    const [lf] = await migrationFiles(dir);
    await writeFile(file, "select 1;\r\n");
    expect((await migrationFiles(dir))[0].checksum).toBe(lf.checksum);
    await writeFile(file, "select 2;\n");
    expect((await migrationFiles(dir))[0].checksum).not.toBe(lf.checksum);
    await writeFile(path.join(dir, "0000_duplicate.sql"), "select 3;");
    await expect(migrationFiles(dir)).rejects.toThrow(/duplicate numbered migration/);
  });
});
