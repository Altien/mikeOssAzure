import { describe, expect, it } from "vitest";
import {
    deploymentModuleEnabled,
    featureEnabled,
} from "./featureFlags";

describe("effective feature availability", () => {
    it("requires both deployment and user enablement", () => {
        expect(
            featureEnabled(
                { playbooks: true },
                "playbooks",
                { playbooks: true },
            ),
        ).toBe(true);
        expect(
            featureEnabled(
                { playbooks: true },
                "playbooks",
                { playbooks: false },
            ),
        ).toBe(false);
        expect(
            featureEnabled(
                { playbooks: false },
                "playbooks",
                { playbooks: true },
            ),
        ).toBe(false);
    });

    it("treats omitted availability as enabled for older API responses", () => {
        expect(featureEnabled(undefined, "legalMonitors")).toBe(true);
        expect(deploymentModuleEnabled(undefined, "gmail")).toBe(true);
    });
});
