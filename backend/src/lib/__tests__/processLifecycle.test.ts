import http from "node:http";
import type { AddressInfo } from "node:net";
import * as Sentry from "@sentry/node";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reportError,
  resetSentryForTests,
  scrubEvent,
} from "../observability/sentry";
import {
  failBoot,
  type LifecycleEffects,
} from "../processLifecycle";

function fakeEffects() {
  return {
    report: vi.fn<LifecycleEffects["report"]>(() => null),
    logError: vi.fn<LifecycleEffects["logError"]>(),
    logInfo: vi.fn<LifecycleEffects["logInfo"]>(),
    flush: vi.fn<LifecycleEffects["flush"]>(async () => {}),
    exit: vi.fn<LifecycleEffects["exit"]>(),
  } satisfies LifecycleEffects;
}

afterEach(async () => {
  await Sentry.close();
});

describe("failBoot (MIKE-BACKEND-2 / -3)", () => {
  // One failed boot used to arrive as two issues: the explicit fatal report
  // and a console-bridge copy of the logged message string. Runs the real
  // console integration and beforeSend so the dedupe is exercised end to end.
  it("sends exactly one event for one failed boot", async () => {
    const events: Sentry.Event[] = [];
    resetSentryForTests("community");
    Sentry.init({
      dsn: "https://test@sentry.invalid/1",
      defaultIntegrations: false,
      integrations: [Sentry.captureConsoleIntegration({ levels: ["error"] })],
      beforeSend: scrubEvent,
      transport: () => ({
        send: async (envelope) => {
          for (const [header, payload] of envelope[1]) {
            if (header.type === "event") events.push(payload as Sentry.Event);
          }
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });
    const exit = vi.fn();
    const failure = Object.assign(
      new Error("Backend authentication configuration is invalid"),
      { code: "configuration_invalid" },
    );

    await failBoot(failure, "runtime-config", {
      // reportError marks the error as sent (tracking is not initialised via
      // initSentry here, so the capture itself goes through the SDK directly).
      report: (error, context) => {
        reportError(error, context);
        return Sentry.captureException(error);
      },
      logError: (...args) => console.error(...args),
      logInfo: () => {},
      flush: async () => {
        await Sentry.flush(2000);
      },
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.logger).not.toBe("console");
  });

  it("reports the failure as fatal with its boot stage before exiting", async () => {
    const effects = fakeEffects();
    const failure = new Error("bad key");
    await failBoot(failure, "manifest-key", effects);
    expect(effects.report).toHaveBeenCalledWith(failure, {
      tags: { component: "boot", stage: "manifest-key" },
      level: "fatal",
    });
    expect(effects.logError).toHaveBeenCalledWith(
      expect.any(String),
      failure,
    );
    expect(effects.exit).toHaveBeenCalledWith(1);
  });
});
