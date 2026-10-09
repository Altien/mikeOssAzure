import express from "express";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => vi.fn());
vi.mock("../../lib/config", () => ({
  getConfig: async () => "",
  getKeyVaultConfig: vault,
}));
import { configRouter } from "./config.routes";

afterEach(() => {
  vault.mockReset();
  delete process.env.SENTRY_FRONTEND_DSN;
  delete process.env.SENTRY_WORD_DSN;
});

it("serves only deployment-configured public Sentry DSNs, vault first", async () => {
  const app = express().use("/config", configRouter);
  vault.mockImplementation(async (name: string) =>
    name === "sentry-frontend-dsn" ? "https://frontend@example.invalid/1" : "https://word@example.invalid/2",
  );
  process.env.SENTRY_FRONTEND_DSN = "https://stale@example.invalid/3";
  const configured = await request(app).get("/config").expect(200);
  expect(configured.body.sentryDsn).toBe("https://frontend@example.invalid/1");
  expect(configured.body.wordSentryDsn).toBe("https://word@example.invalid/2");

  vault.mockRejectedValue(new Error("No vault configured"));
  delete process.env.SENTRY_FRONTEND_DSN;
  delete process.env.SENTRY_WORD_DSN;
  const disabled = await request(app).get("/config").expect(200);
  expect(disabled.body.sentryDsn).toBe("");
  expect(disabled.body.wordSentryDsn).toBe("");
});
