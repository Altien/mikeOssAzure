import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveRoles } from "./roles";

// Adapted from the OSS mirror suite to dev's current resolveRoles:
// async (KV-aware via getConfig, env-first), case-INSENSITIVE group
// matching, `# comment` stripping, and the 040 Entry 7 fix A semantics
// where an empty member-group list means "anyone in the tenant".

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
  it("grants Member when no groups are configured at all (tenant membership is the only gate)", async () => {
    delete process.env[ADMIN];
    delete process.env[MEMBER];

    expect(await resolveRoles(["any-group"])).toEqual(["Member"]);
  });

  it("returns no roles when groups are configured but the user has no group claims", async () => {
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

  it("denies a non-member when a member allowlist IS configured", async () => {
    process.env[ADMIN] = "admin-1";
    process.env[MEMBER] = "member-1";

    expect(await resolveRoles(["unrelated-group"])).toEqual([]);
  });

  it("trims whitespace and drops empty entries from the CSV values", async () => {
    process.env[ADMIN] = " admin-1 ,  ,admin-2 ";
    process.env[MEMBER] = "member-1";

    expect(await resolveRoles(["admin-2"])).toEqual(["TenantAdmin", "Member"]);
    expect(await resolveRoles([""])).toEqual([]);
  });

  it("matches group ids case-insensitively (Entra GUIDs vary in casing across surfaces)", async () => {
    process.env[ADMIN] = "Admin-Group-Guid";
    process.env[MEMBER] = "member-group-guid";

    expect(await resolveRoles(["admin-group-guid"])).toEqual([
      "TenantAdmin",
      "Member",
    ]);
    expect(await resolveRoles(["MEMBER-GROUP-GUID"])).toEqual(["Member"]);
  });

  it("strips `# display-name` comments from configured values before comparing", async () => {
    process.env[ADMIN] = "admin-1 # Mike Admins";
    process.env[MEMBER] = "member-1 # Mike Users";

    expect(await resolveRoles(["admin-1"])).toEqual(["TenantAdmin", "Member"]);
    expect(await resolveRoles(["member-1"])).toEqual(["Member"]);
  });

  it("prefers admin when the user is in both admin and member groups", async () => {
    process.env[ADMIN] = "g1";
    process.env[MEMBER] = "g2";

    expect(await resolveRoles(["g1", "g2"])).toEqual(["TenantAdmin", "Member"]);
  });
});
