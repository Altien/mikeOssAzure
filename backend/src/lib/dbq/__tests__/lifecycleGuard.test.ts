import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../supabase", () => ({ createServerSupabase: () => ({}) }));

import {
  enforceDocumentLifecycleMigration,
  evaluateLifecycleProbe,
  probeDocumentLifecycle,
  type LifecycleProbe,
} from "../lifecycleGuard";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const probeDb = (result: LifecycleProbe) =>
  ({ rpc: vi.fn(async () => result) }) as never;

describe("document lifecycle boot guard", () => {
  it("passes when the database reports the lifecycle contract", () => {
    expect(evaluateLifecycleProbe({ data: 2, error: null })).toEqual({
      status: "ok",
    });
    // PostgREST hands back a scalar RPC result as a bare value or a one-row
    // array depending on the client; both mean the same thing.
    expect(evaluateLifecycleProbe({ data: [2], error: null }).status).toBe(
      "ok",
    );
    // A newer database than the build is fine: the contract only grows.
    expect(evaluateLifecycleProbe({ data: 3, error: null }).status).toBe("ok");
  });

  // 20260914_01 applied but not 20260916_01: the RPCs exist, the upload
  // marker column does not. Code that stamps the marker would fail every
  // new-document upload while a "functions exist" probe still said healthy.
  it("fails when the database is behind the version this build needs", () => {
    const verdict = evaluateLifecycleProbe({ data: 1, error: null });
    expect(verdict.status).toBe("missing");
    expect(verdict.status === "missing" && verdict.message).toMatch(
      /found version 1, need 2/,
    );
    expect(verdict.status === "missing" && verdict.message).toMatch(
      /new-document upload/,
    );
  });

  it("fails when the probe reports the lifecycle RPCs are absent", () => {
    const verdict = evaluateLifecycleProbe({ data: 0, error: null });
    expect(verdict.status).toBe("missing");
    // The operator has to be told what to DO, not just what is broken.
    expect(verdict.status === "missing" && verdict.message).toMatch(
      /Apply the migrations/,
    );
  });

  it("fails when the probe function itself is missing", () => {
    for (const code of ["PGRST202", "42883"]) {
      expect(
        evaluateLifecycleProbe({ data: null, error: { code } }).status,
      ).toBe("missing");
    }
  });

  // One probe cannot distinguish a transient startup outage from a database
  // that will recover without the required migration. The boot gate retries
  // this verdict and ultimately fails closed.
  it("marks any other failure inconclusive for the retrying boot gate", () => {
    expect(
      evaluateLifecycleProbe({
        data: null,
        error: { code: "57P03", message: "the database system is starting up" },
      }).status,
    ).toBe("inconclusive");
    expect(evaluateLifecycleProbe({ data: null, error: null }).status).toBe(
      "inconclusive",
    );
  });

  it("stops the process on a missing migration", async () => {
    const exit = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await enforceDocumentLifecycleMigration(
      probeDb({ data: 0, error: null }),
      exit as never,
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalled();
  });

  it("retries an unavailable probe and serves once the contract is confirmed", async () => {
    const exit = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sleep = vi.fn(async () => {});
    const db = {
      rpc: vi
        .fn()
        .mockResolvedValueOnce({
          data: null,
          error: { code: "57P03", message: "starting up" },
        })
        .mockResolvedValueOnce({ data: 2, error: null }),
    } as never;
    await enforceDocumentLifecycleMigration(db, exit as never, {
      attempts: 2,
      sleep,
    });
    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("fails closed when every retry is inconclusive", async () => {
    const exit = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sleep = vi.fn(async () => {});
    const db = probeDb({
      data: null,
      error: { code: "57P03", message: "starting up" },
    });

    await enforceDocumentLifecycleMigration(db, exit as never, {
      attempts: 3,
      sleep,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/Refusing to start.*version 2/),
    );
  });

  it("can be switched off for a deployment that accepts the risk", async () => {
    vi.stubEnv("DOCUMENT_LIFECYCLE_GUARD", "off");
    const exit = vi.fn();
    const db = probeDb({ data: 0, error: null });
    await enforceDocumentLifecycleMigration(db, exit as never);
    expect(exit).not.toHaveBeenCalled();
  });

  it("treats a thrown client error as inconclusive", async () => {
    const db = {
      rpc: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    } as never;
    expect((await probeDocumentLifecycle(db)).status).toBe("inconclusive");
  });
});
