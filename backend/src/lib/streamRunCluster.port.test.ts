import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pg", () => ({
  Pool: class {},
  Client: class {
    async connect() { throw new Error("direct connection reached"); }
  },
}));
vi.mock("./config", () => ({ getKeyVaultConfig: vi.fn() }));
vi.mock("./serverSession", () => ({ deriveServerRelayKey: () => Buffer.alloc(32) }));
import { StreamRunCluster } from "./streamRunCluster";

beforeEach(() => {
  vi.stubEnv("KEY_VAULT_NAME", "");
  vi.stubEnv("AUTH_PROVIDER", "local");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("direct stream-run database port boundary", () => {
  it("admits the supervised local PostgreSQL port only for literal-loopback local auth", async () => {
    vi.stubEnv("STREAM_RUN_DATABASE_URL", "postgres://test@127.0.0.1:42810/postgres");
    await expect(StreamRunCluster.start()).rejects.toThrow("direct connection reached");
    vi.stubEnv("AUTH_PROVIDER", "entra");
    await expect(StreamRunCluster.start()).rejects.toThrow("direct PostgreSQL port 5432");
  });

  it("retains the remote direct-port restriction even under local auth", async () => {
    vi.stubEnv("STREAM_RUN_DATABASE_URL", "postgres://test@database.example.test:42810/postgres");
    await expect(StreamRunCluster.start()).rejects.toThrow("direct PostgreSQL port 5432");
    vi.stubEnv("STREAM_RUN_DATABASE_URL", "postgres://test@database.example.test:5432/postgres");
    await expect(StreamRunCluster.start()).rejects.toThrow("direct connection reached");
  });
});
