import { describe, expect, it } from "vitest";
import {
  createStorageProvider,
  resolveStorageProvider,
} from "../storage";

describe("storage provider selection", () => {
  it("defaults fresh deployments to SQLite", () => {
    expect(resolveStorageProvider({})).toBe("sqlite");
  });

  it("honors the explicit SQLite provider", () => {
    expect(resolveStorageProvider({ MIKE_STORAGE_PROVIDER: "SQLITE" })).toBe(
      "sqlite",
    );
  });

  it("keeps pre-provider SQLite storage installations working", () => {
    expect(
      resolveStorageProvider({ SQLITE_STORAGE_PATH: "./data/mike-files.sqlite" }),
    ).toBe("sqlite");
  });

  it("rejects unknown providers", () => {
    expect(() =>
      resolveStorageProvider({ MIKE_STORAGE_PROVIDER: "filesystem" }),
    ).toThrow('Unsupported MIKE_STORAGE_PROVIDER "filesystem"');
  });

  it("rejects the removed R2 provider", () => {
    expect(() =>
      resolveStorageProvider({ MIKE_STORAGE_PROVIDER: "r2" }),
    ).toThrow('Unsupported MIKE_STORAGE_PROVIDER "r2"');
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
