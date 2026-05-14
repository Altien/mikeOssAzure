import { buildApp } from "../../app";

/**
 * Convenience wrapper around buildApp() for route tests.
 *
 * Calling buildApp() inside the test (rather than at module load) means
 * each test sees the env vars it has just set in beforeEach. Reuse this
 * helper everywhere route tests reach for the app — direct
 * `import { buildApp } from "@/app"` works too, but going through this
 * one symbol makes it easy to add cross-cutting test setup later
 * (e.g. installing a mocked auth middleware) without touching every
 * test file.
 */
export function makeApp() {
  return buildApp();
}
