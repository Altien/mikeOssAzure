import { describe, expect, it } from "vitest";
import {
  createStorageProvider,
  resolveStorageProvider,
} from "../storage";

describe("storage provider selection", () => {
  it("defaults fresh deployments to upstream R2", () => {
    expect(resolveStorageProvider({})).toBe("r2");
  });

  it("honors an explicit provider", () => {
    expect(resolveStorageProvider({ MIKE_STORAGE_PROVIDER: "r2" })).toBe("r2");
    expect(resolveStorageProvider({ MIKE_STORAGE_PROVIDER: "SQLITE" })).toBe(
      "sqlite",
    );
  });

  it("keeps pre-provider SQLite storage installations working", () => {
    expect(
      resolveStorageProvider({ SQLITE_STORAGE_PATH: "./data/mike-files.sqlite" }),
    ).toBe("sqlite");
  });

  it("does not override configured R2 with a legacy SQLite path", () => {
    expect(
      resolveStorageProvider({
        SQLITE_STORAGE_PATH: "./data/mike-files.sqlite",
        R2_ENDPOINT_URL: "https://example.r2.cloudflarestorage.com",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
      }),
    ).toBe("r2");
  });

  it("rejects unknown providers", () => {
    expect(() =>
      resolveStorageProvider({ MIKE_STORAGE_PROVIDER: "filesystem" }),
    ).toThrow('Unsupported MIKE_STORAGE_PROVIDER "filesystem"');
  });

  it("creates the selected SQLite provider in the test profile", () => {
    expect(createStorageProvider()).toEqual(
      expect.objectContaining({
        enabled: true,
        uploadFile: expect.any(Function),
        downloadFile: expect.any(Function),
      }),
    );
  });
});
