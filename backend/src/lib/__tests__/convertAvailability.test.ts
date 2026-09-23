// MIKE-BACKEND-9: "Failure in upload-worker / conversion" from a developer
// machine running the backend outside Docker. The Docker image installs
// LibreOffice (/usr/bin/soffice), but the official macOS installer puts
// soffice inside the app bundle and adds nothing to PATH, so the worker
// declared LibreOffice missing on a machine that had it.
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let workDirectory: string;
beforeAll(async () => {
  workDirectory = await mkdtemp(join(osTmpdir(), "mike-convert-avail-"));
});
afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});
const tmpdir = () => workDirectory;
import { diagnosticErrorTags } from "../observability/sentryPrivacy";

const MAC_BUNDLE_SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice";

afterEach(() => {
  vi.restoreAllMocks();
});

async function freshConverter() {
  vi.resetModules();
  return await import("../convert.js");
}

describe("soffice discovery", () => {
  it("finds LibreOffice in the macOS app bundle", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation((file) => {
      if (file !== MAC_BUNDLE_SOFFICE) throw new Error("missing");
    });
    const { officeFileToPdf } = await freshConverter();

    const failure = await officeFileToPdf(
      "source.docx",
      tmpdir(),
    ).catch((error: unknown) => error);

    // The bundle binary was chosen and spawned (it does not exist on the
    // test host, so the spawn itself fails) instead of the converter
    // giving up with conversion_unavailable before trying.
    expect(diagnosticErrorTags(failure).failure_code).not.toBe(
      "conversion_unavailable",
    );
    expect((failure as { path?: string }).path).toBe(MAC_BUNDLE_SOFFICE);
  });

  it("says how to fix a missing LibreOffice without naming one hosting provider", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("missing");
    });
    const { officeFileToPdf } = await freshConverter();

    const failure = (await officeFileToPdf("source.docx", tmpdir()).catch(
      (error: unknown) => error,
    )) as Error;

    expect(diagnosticErrorTags(failure)).toEqual({
      failure_code: "conversion_unavailable",
    });
    expect(failure.message).toContain("SOFFICE_BINARY_PATH");
    expect(failure.message).not.toContain("Railway");
  });
});
