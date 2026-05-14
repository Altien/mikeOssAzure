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
  it("returns no roles when no env groups are configured", () => {
    delete process.env[ADMIN];
    delete process.env[MEMBER];

    expect(resolveRoles(["any-group"])).toEqual([]);
  });

  it("returns no roles when the user has no group claims", () => {
    process.env[ADMIN] = "admin-1";
    process.env[MEMBER] = "member-1";

    expect(resolveRoles([])).toEqual([]);
  });

  it("returns [TenantAdmin, Member] for any admin-group match", () => {
    process.env[ADMIN] = "admin-1,admin-2";
    process.env[MEMBER] = "member-1";

    expect(resolveRoles(["unrelated", "admin-2"])).toEqual([
      "TenantAdmin",
      "Member",
    ]);
  });

  it("returns [Member] when only the member group matches", () => {
    process.env[ADMIN] = "admin-1";
    process.env[MEMBER] = "member-1,member-2";

    expect(resolveRoles(["member-2"])).toEqual(["Member"]);
  });

  it("treats the admin group as a superset — admin match alone yields both roles", () => {
    process.env[ADMIN] = "admin-1";
    delete process.env[MEMBER];

    expect(resolveRoles(["admin-1"])).toEqual(["TenantAdmin", "Member"]);
  });

  it("trims whitespace and drops empty entries from the CSV env vars", () => {
    process.env[ADMIN] = " admin-1 ,  ,admin-2 ";
    process.env[MEMBER] = "";

    expect(resolveRoles(["admin-2"])).toEqual(["TenantAdmin", "Member"]);
    expect(resolveRoles([""])).toEqual([]);
  });

  it("is case-sensitive on group ids — case mismatch is not a match", () => {
    process.env[ADMIN] = "Admin-Group-Guid";
    process.env[MEMBER] = "member-group-guid";

    expect(resolveRoles(["admin-group-guid"])).toEqual([]);
    expect(resolveRoles(["MEMBER-GROUP-GUID"])).toEqual([]);
  });

  it("prefers admin when the user is in both admin and member groups", () => {
    process.env[ADMIN] = "g1";
    process.env[MEMBER] = "g2";

    expect(resolveRoles(["g1", "g2"])).toEqual(["TenantAdmin", "Member"]);
  });
});
