import { expect, it, vi } from "vitest";
import { addinSentryOptions } from "../../../../word-addin/src/taskpane/lib/errorReporting";

// Dev (sync-log: bd719ea6): upstream also drives its Next server/edge
// serverSentryOptions and an explicit Mike-project DSN (capped at 50). Dev has
// no Next server and bakes no Mike-project DSN, so only the add-in with a
// custom project is carried: it stays uncapped and the canary never leaks.
it.each(["addin"] as const)("%s caps an explicit Mike DSN but leaves custom projects independent", async () => {
    for (const [dsn, count] of [["https://own@sentry.invalid/42", 60]] as const) {
        const options = addinSentryOptions("taskpane", { nodeEnv: "production", dsn });
        const integrations = options.integrations;
        if (!Array.isArray(integrations)) throw new Error("Expected explicit integrations");
        const integration = integrations.find(item => item.name === "MikePrivacyBoundary");
        const send = vi.fn(async (_envelope: unknown) => ({ statusCode: 200 }));
        const transport = { send };
        // Drive the configured final transport, not a separately constructed budget.
        (integration as unknown as { setup(client: unknown): void }).setup({ getTransport: () => transport });
        for (let n = 0; n < 60; n++) await transport.send([{}, [[{ type: "event" }, { message: "PRIVATE_QUOTA_CANARY", tags: { diagnostic_test: "true" } }]]]);
        expect(send).toHaveBeenCalledTimes(count);
        expect(JSON.stringify(send.mock.calls)).not.toContain("PRIVATE_QUOTA_CANARY");
    }
});
