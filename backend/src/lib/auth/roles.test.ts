import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveRoles } from "./roles";

const ADMIN = "ENTRA_ADMIN_GROUP_IDS";
const MEMBER = "ENTRA_MEMBER_GROUP_IDS";

const snapshot = {} as Record<string, string | undefined>;

beforeEach(() => {
  snapshot[ADMIN] = process.env[ADMIN];
  snapshot[MEMBER] = process.env[MEMBER];
});

afterEach(() => {
  for (const k of [ADMIN, MEMBER]) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe("resolveRoles", () => {
  it("grants Member when no group lists are configured (tenant-membership default)", async () => {
    // Promoted behavior: an empty member-group list means "no restriction
    // beyond tenant membership", so any caller (tid already verified
    // upstream) gets Member. See roles.ts "Closes 040 Entry 7 fix A".
    delete process.env[ADMIN];
    delete process.env[MEMBER];

    expect(await resolveRoles(["any-group"])).toEqual(["Member"]);
  });

  it("returns no roles when the user has no group claims", async () => {
    process.env[ADMIN] = "admin-1";
    process.env[MEMBER] = "member-1";

    expect(await resolveRoles([])).toEqual([]);
  });

  it("returns [TenantAdmin, Member] for any admin-group match", async () => {
    process.env[ADMIN] = "admin-1,admin-2";
    process.env[MEMBER] = "member-1";

    expect(await resolveRoles(["unrelated", "admin-2"])).toEqual([
      "TenantAdmin",
      "Member",
    ]);
  });

  it("returns [Member] when only the member group matches", async () => {
    process.env[ADMIN] = "admin-1";
    process.env[MEMBER] = "member-1,member-2";

    expect(await resolveRoles(["member-2"])).toEqual(["Member"]);
  });

  it("treats the admin group as a superset — admin match alone yields both roles", async () => {
    process.env[ADMIN] = "admin-1";
    delete process.env[MEMBER];

    expect(await resolveRoles(["admin-1"])).toEqual(["TenantAdmin", "Member"]);
  });

  it("trims whitespace and drops empty entries from the CSV env vars", async () => {
    process.env[ADMIN] = " admin-1 ,  ,admin-2 ";
    process.env[MEMBER] = "member-1";

    expect(await resolveRoles(["admin-2"])).toEqual(["TenantAdmin", "Member"]);
    // No admin/member match, but the member list is non-empty so the
    // tenant-membership default does not apply here.
    expect(await resolveRoles([""])).toEqual([]);
  });

  it("is case-insensitive on group ids — GUID case mismatch still matches", async () => {
    // Promoted code lowercases both the configured and the claimed group
    // ids before comparison (GUIDs are canonically case-insensitive).
    process.env[ADMIN] = "Admin-Group-Guid";
    process.env[MEMBER] = "member-group-guid";

    expect(await resolveRoles(["admin-group-guid"])).toEqual([
      "TenantAdmin",
      "Member",
    ]);
    expect(await resolveRoles(["MEMBER-GROUP-GUID"])).toEqual(["Member"]);
  });

  it("prefers admin when the user is in both admin and member groups", async () => {
    process.env[ADMIN] = "g1";
    process.env[MEMBER] = "g2";

    expect(await resolveRoles(["g1", "g2"])).toEqual(["TenantAdmin", "Member"]);
  });
});
