import "@testing-library/jest-dom/vitest";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeAll, afterAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { server } from "./msw-server";

// Node's Response.blob() needs the native Blob methods under Vitest jsdom.
// The jsdom replacement lacks arrayBuffer()/stream() on Node 22 and 24.
globalThis.Blob = NodeBlob as unknown as typeof Blob;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
    cleanup();
    server.resetHandlers();
    window.localStorage.clear();
    window.sessionStorage.clear();
});
afterAll(() => server.close());
