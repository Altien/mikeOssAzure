import { beforeEach, describe, expect, it, vi } from "vitest";

const { configValues, getConfigMock, setConfigMock } = vi.hoisted(() => {
    const values = new Map<string, string>();
    return {
        configValues: values,
        getConfigMock: vi.fn(async (name: string) => values.get(name) ?? ""),
        setConfigMock: vi.fn(async (name: string, value: string) => {
            values.set(name, value);
            return `https://example.vault.azure.net/secrets/${name}/version`;
        }),
    };
});

vi.mock("../config", () => ({
    getConfig: getConfigMock,
    setConfig: setConfigMock,
}));

import { isInitialAdmin, isSelfBootstrapAllowed } from "./installAuth";

describe("install administrator bootstrap", () => {
    beforeEach(() => {
        configValues.clear();
        getConfigMock
            .mockReset()
            .mockImplementation(
                async (name: string) => configValues.get(name) ?? "",
            );
        setConfigMock
            .mockReset()
            .mockImplementation(async (name: string, value: string) => {
                configValues.set(name, value);
                return `https://example.vault.azure.net/secrets/${name}/version`;
            });
        configValues.set("entra-tenant-id", "tenant-1");
        configValues.set("entra-admin-group-ids", "");
    });

    it("remembers the first self-bootstrap user as the permanent initial administrator", async () => {
        await expect(
            isSelfBootstrapAllowed(
                "tenant-1",
                "first.admin@example.test",
                "11111111-1111-4111-8111-111111111111",
            ),
        ).resolves.toBe(true);

        // Reproduce the reported lockout: setup records an admin group that
        // does not resolve for the user who performed the first sign-in.
        configValues.set("entra-admin-group-ids", "some-other-group");

        await expect(
            isInitialAdmin(
                "11111111-1111-4111-8111-111111111111",
                "first.admin@example.test",
            ),
        ).resolves.toBe(true);
        expect(configValues.get("install-initial-admin-oid")).toBe(
            "11111111-1111-4111-8111-111111111111",
        );
        expect(configValues.get("install-initial-admin-email")).toBe(
            "first.admin@example.test",
        );
    });

    it("does not claim a different first administrator when the existing identity cannot be read", async () => {
        getConfigMock.mockImplementation(async (name: string) => {
            if (name === "install-initial-admin-oid") {
                throw new Error("Key Vault unavailable");
            }
            return configValues.get(name) ?? "";
        });

        await expect(
            isSelfBootstrapAllowed(
                "tenant-1",
                "other.admin@example.test",
                "22222222-2222-4222-8222-222222222222",
            ),
        ).resolves.toBe(false);
        expect(setConfigMock).not.toHaveBeenCalled();
    });

    it("never replaces an initial administrator that was already recorded", async () => {
        configValues.set(
            "install-initial-admin-oid",
            "11111111-1111-4111-8111-111111111111",
        );
        configValues.set(
            "install-initial-admin-email",
            "first.admin@example.test",
        );

        await expect(
            isSelfBootstrapAllowed(
                "tenant-1",
                "other.admin@example.test",
                "22222222-2222-4222-8222-222222222222",
            ),
        ).resolves.toBe(false);
        expect(configValues.get("install-initial-admin-oid")).toBe(
            "11111111-1111-4111-8111-111111111111",
        );
        expect(setConfigMock).not.toHaveBeenCalled();
    });

    it("fails closed when the first administrator cannot be persisted", async () => {
        setConfigMock.mockRejectedValue(new Error("Key Vault write failed"));

        await expect(
            isSelfBootstrapAllowed(
                "tenant-1",
                "first.admin@example.test",
                "11111111-1111-4111-8111-111111111111",
            ),
        ).resolves.toBe(false);
    });

    it("treats an absent initial-admin Key Vault secret as unclaimed", async () => {
        getConfigMock.mockImplementation(async (name: string) => {
            if (name === "install-initial-admin-oid") {
                throw Object.assign(new Error("Secret not found"), {
                    statusCode: 404,
                    code: "SecretNotFound",
                });
            }
            return configValues.get(name) ?? "";
        });

        await expect(
            isSelfBootstrapAllowed(
                "tenant-1",
                "first.admin@example.test",
                "11111111-1111-4111-8111-111111111111",
            ),
        ).resolves.toBe(true);
        expect(configValues.get("install-initial-admin-oid")).toBe(
            "11111111-1111-4111-8111-111111111111",
        );
    });
});
