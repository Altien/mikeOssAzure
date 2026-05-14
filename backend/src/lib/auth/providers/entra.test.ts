import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { generateKeyPairSync, createSign } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwkPublic = publicKey.export({ format: "jwk" }) as {
  kty: string;
  n: string;
  e: string;
};
const KID = "test-kid-1";
const JWK = { ...jwkPublic, kid: KID };
const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_ID = "22222222-2222-2222-2222-222222222222";

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signRS256(headerB64: string, payloadB64: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(`${headerB64}.${payloadB64}`);
  signer.end();
  return b64url(signer.sign(privateKey));
}

function makeToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  return `${h}.${p}.${signRS256(h, p)}`;
}

const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;
const PAST = () => Math.floor(Date.now() / 1000) - 3600;
const V2_ISS = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const V1_ISS = `https://sts.windows.net/${TENANT_ID}/`;

function baseClaims(): Record<string, unknown> {
  return {
    iss: V2_ISS,
    aud: CLIENT_ID,
    tid: TENANT_ID,
    exp: FUTURE(),
    oid: "user-oid-1",
    preferred_username: "caller@example.com",
    name: "Caller Example",
  };
}

function baseHeader(): Record<string, unknown> {
  return { alg: "RS256", kid: KID, typ: "JWT" };
}

let mockFetch: ReturnType<typeof vi.fn>;
let validateEntraToken: (token: string) => Promise<unknown>;

const envSnapshot = {} as Record<string, string | undefined>;

beforeEach(async () => {
  envSnapshot.ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID;
  envSnapshot.ENTRA_BACKEND_CLIENT_ID = process.env.ENTRA_BACKEND_CLIENT_ID;
  process.env.ENTRA_TENANT_ID = TENANT_ID;
  process.env.ENTRA_BACKEND_CLIENT_ID = CLIENT_ID;

  mockFetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ keys: [JWK] }),
    } as unknown as Response),
  );
  vi.stubGlobal("fetch", mockFetch);
  vi.spyOn(console, "warn").mockImplementation(() => {});

  // Fresh module per test so the JWKS cache doesn't leak across cases.
  vi.resetModules();
  ({ validateEntraToken } = await import("./entra"));
});

afterEach(() => {
  for (const k of ["ENTRA_TENANT_ID", "ENTRA_BACKEND_CLIENT_ID"] as const) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  vi.unstubAllGlobals();
});

describe("validateEntraToken — configuration", () => {
  it("rejects when ENTRA_TENANT_ID is missing", async () => {
    delete process.env.ENTRA_TENANT_ID;

    const result = await validateEntraToken(makeToken(baseHeader(), baseClaims()));

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Server auth is not configured",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects when ENTRA_BACKEND_CLIENT_ID is missing", async () => {
    delete process.env.ENTRA_BACKEND_CLIENT_ID;

    const result = await validateEntraToken(makeToken(baseHeader(), baseClaims()));

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Server auth is not configured",
    });
  });
});

describe("validateEntraToken — structural & algorithm checks", () => {
  it("rejects a token without three parts", async () => {
    expect(await validateEntraToken("a.b")).toMatchObject({
      ok: false,
      status: 401,
      detail: "Malformed JWT",
    });
  });

  it("rejects when the header is not valid base64-JSON", async () => {
    const result = await validateEntraToken("not-json!.payload.sig");

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      detail: "Malformed JWT",
    });
  });

  it("rejects alg != RS256 — guards against the HS256/none confusion attack", async () => {
    const token = makeToken({ alg: "HS256", kid: KID }, baseClaims());

    expect(await validateEntraToken(token)).toMatchObject({
      ok: false,
      status: 401,
      detail: "Invalid token algorithm",
    });
  });

  it("rejects when the header has no kid (no way to choose a key)", async () => {
    const token = makeToken({ alg: "RS256" }, baseClaims());

    expect(await validateEntraToken(token)).toMatchObject({
      ok: false,
      status: 401,
      detail: "Missing token key id",
    });
  });
});

describe("validateEntraToken — JWKS lookup", () => {
  it("calls the tenant-scoped JWKS endpoint", async () => {
    await validateEntraToken(makeToken(baseHeader(), baseClaims()));

    expect(mockFetch).toHaveBeenCalledWith(
      `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
    );
  });

  it("rejects when the JWKS fetch returns a non-200 response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false } as unknown as Response);

    expect(
      await validateEntraToken(makeToken(baseHeader(), baseClaims())),
    ).toMatchObject({ ok: false, status: 401, detail: "Invalid or expired token" });
  });

  it("rejects when no JWK matches the kid in the header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ keys: [{ ...JWK, kid: "different-kid" }] }),
    } as unknown as Response);

    const result = await validateEntraToken(makeToken(baseHeader(), baseClaims()));

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      detail: "Invalid or expired token",
    });
  });

  it("rejects when the matching JWK is missing the n or e parameter", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ keys: [{ kid: KID, kty: "RSA" }] }),
    } as unknown as Response);

    expect(
      await validateEntraToken(makeToken(baseHeader(), baseClaims())),
    ).toMatchObject({ ok: false, status: 401, detail: "Invalid or expired token" });
  });

  it("treats a JWKS body without a keys array as empty (no crash, just no match)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    expect(
      await validateEntraToken(makeToken(baseHeader(), baseClaims())),
    ).toMatchObject({ ok: false, status: 401, detail: "Invalid or expired token" });
  });

  it("caches the JWKS for repeated calls with the same tenant id", async () => {
    await validateEntraToken(makeToken(baseHeader(), baseClaims()));
    await validateEntraToken(makeToken(baseHeader(), baseClaims()));
    await validateEntraToken(makeToken(baseHeader(), baseClaims()));

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("validateEntraToken — signature verification", () => {
  it("rejects a token whose payload has been tampered with", async () => {
    const valid = makeToken(baseHeader(), baseClaims());
    const [h, , s] = valid.split(".");
    const tamperedPayload = b64url(
      Buffer.from(JSON.stringify({ ...baseClaims(), oid: "attacker" })),
    );

    const result = await validateEntraToken(`${h}.${tamperedPayload}.${s}`);

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      detail: "Invalid or expired token",
    });
  });

  it("rejects a token signed by a different RSA key (key-substitution)", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const h = b64url(Buffer.from(JSON.stringify(baseHeader())));
    const p = b64url(Buffer.from(JSON.stringify(baseClaims())));
    const sig = createSign("RSA-SHA256")
      .update(`${h}.${p}`)
      .end();
    const badSig = b64url(sig.sign(other.privateKey));
    const token = `${h}.${p}.${badSig}`;

    const result = await validateEntraToken(token);

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      detail: "Invalid or expired token",
    });
  });
});

describe("validateEntraToken — claim validation", () => {
  it("rejects when issuer is neither the v1 nor v2 form for the configured tenant", async () => {
    const token = makeToken(baseHeader(), {
      ...baseClaims(),
      iss: "https://login.microsoftonline.com/other-tenant/v2.0",
    });

    expect(await validateEntraToken(token)).toMatchObject({
      ok: false,
      status: 401,
      detail: "Invalid issuer",
    });
  });

  it("accepts the v1.0 issuer (sts.windows.net)", async () => {
    const token = makeToken(baseHeader(), { ...baseClaims(), iss: V1_ISS });

    expect(await validateEntraToken(token)).toMatchObject({ ok: true });
  });

  it("accepts the v2.0 issuer (login.microsoftonline.com)", async () => {
    const token = makeToken(baseHeader(), { ...baseClaims(), iss: V2_ISS });

    expect(await validateEntraToken(token)).toMatchObject({ ok: true });
  });

  it("accepts the v1-style audience 'api://<clientid>'", async () => {
    const token = makeToken(baseHeader(), {
      ...baseClaims(),
      aud: `api://${CLIENT_ID}`,
    });

    expect(await validateEntraToken(token)).toMatchObject({ ok: true });
  });

  it("rejects an audience that doesn't match either accepted shape", async () => {
    const token = makeToken(baseHeader(), {
      ...baseClaims(),
      aud: "different-app",
    });

    expect(await validateEntraToken(token)).toMatchObject({
      ok: false,
      status: 401,
      detail: "Invalid audience",
    });
  });

  it("rejects when the audience claim is not a string (e.g. an array, which v1 tokens can carry)", async () => {
    const token = makeToken(baseHeader(), {
      ...baseClaims(),
      aud: [CLIENT_ID],
    });

    expect(await validateEntraToken(token)).toMatchObject({
      ok: false,
      status: 401,
      detail: "Invalid audience",
    });
  });

  it("rejects when the tid claim doesn't match the configured tenant", async () => {
    const token = makeToken(baseHeader(), {
      ...baseClaims(),
      tid: "33333333-3333-3333-3333-333333333333",
    });

    expect(await validateEntraToken(token)).toMatchObject({
      ok: false,
      status: 401,
      detail: "Invalid tenant",
    });
  });

  it("rejects when exp is missing", async () => {
    const claims = baseClaims();
    delete (claims as Record<string, unknown>).exp;
    const token = makeToken(baseHeader(), claims);

    expect(await validateEntraToken(token)).toMatchObject({
      ok: false,
      status: 401,
      detail: "Token missing exp claim",
    });
  });

  it("rejects when exp is in the past", async () => {
    const token = makeToken(baseHeader(), { ...baseClaims(), exp: PAST() });

    expect(await validateEntraToken(token)).toMatchObject({
      ok: false,
      status: 401,
      detail: "Token expired",
    });
  });

  it("rejects when nbf is in the future (token not yet valid)", async () => {
    const token = makeToken(baseHeader(), {
      ...baseClaims(),
      nbf: FUTURE(),
    });

    expect(await validateEntraToken(token)).toMatchObject({
      ok: false,
      status: 401,
      detail: "Token is not yet valid",
    });
  });

  it("accepts when nbf is absent (not all tokens carry one)", async () => {
    const claims = baseClaims();
    delete (claims as Record<string, unknown>).nbf;
    const token = makeToken(baseHeader(), claims);

    expect(await validateEntraToken(token)).toMatchObject({ ok: true });
  });

  it("rejects when oid is missing — no user identity to attach to", async () => {
    const claims = baseClaims();
    delete (claims as Record<string, unknown>).oid;
    const token = makeToken(baseHeader(), claims);

    expect(await validateEntraToken(token)).toMatchObject({
      ok: false,
      status: 401,
      detail: "Token missing oid claim",
    });
  });
});

describe("validateEntraToken — principal shape on success", () => {
  it("returns a fully-populated principal with tenant + lowercased email + display name", async () => {
    const token = makeToken(baseHeader(), {
      ...baseClaims(),
      preferred_username: "Caller@Example.COM",
      groups: ["g1", "g2"],
    });

    const result = await validateEntraToken(token);

    expect(result).toMatchObject({
      ok: true,
      principal: {
        userId: "user-oid-1",
        email: "caller@example.com",
        displayName: "Caller Example",
        tenantId: TENANT_ID,
        groups: ["g1", "g2"],
        roles: [],
        provider: "entra",
      },
    });
  });

  it("falls back through preferred_username → email → upn → unique_name for the email", async () => {
    const claims = baseClaims();
    delete (claims as Record<string, unknown>).preferred_username;
    (claims as Record<string, unknown>).email = "v2@example.com";
    const r1 = await validateEntraToken(makeToken(baseHeader(), claims));
    expect((r1 as { principal: { email: string } }).principal.email).toBe(
      "v2@example.com",
    );

    const c2 = baseClaims();
    delete (c2 as Record<string, unknown>).preferred_username;
    (c2 as Record<string, unknown>).upn = "v1@example.com";
    const r2 = await validateEntraToken(makeToken(baseHeader(), c2));
    expect((r2 as { principal: { email: string } }).principal.email).toBe(
      "v1@example.com",
    );

    const c3 = baseClaims();
    delete (c3 as Record<string, unknown>).preferred_username;
    (c3 as Record<string, unknown>).unique_name = "legacy@example.com";
    const r3 = await validateEntraToken(makeToken(baseHeader(), c3));
    expect((r3 as { principal: { email: string } }).principal.email).toBe(
      "legacy@example.com",
    );
  });

  it("logs auth.entra.email_missing and returns email='' when no email-shaped claim is present", async () => {
    const claims = baseClaims();
    for (const k of ["preferred_username", "email", "upn", "unique_name"]) {
      delete (claims as Record<string, unknown>)[k];
    }
    const token = makeToken(baseHeader(), claims);

    const result = await validateEntraToken(token);

    expect(result).toMatchObject({ ok: true, principal: { email: "" } });
    expect(console.warn).toHaveBeenCalledWith(
      "auth.entra.email_missing",
      expect.objectContaining({ provider: "entra", userId: "user-oid-1" }),
    );
  });

  it("assembles displayName from given_name + family_name when name is absent", async () => {
    const claims = baseClaims();
    delete (claims as Record<string, unknown>).name;
    (claims as Record<string, unknown>).given_name = "Ada";
    (claims as Record<string, unknown>).family_name = "Lovelace";
    const token = makeToken(baseHeader(), claims);

    const result = await validateEntraToken(token);

    expect((result as { principal: { displayName: string } }).principal.displayName)
      .toBe("Ada Lovelace");
  });

  it("falls back to preferred_username when no name claims are present", async () => {
    const claims = baseClaims();
    delete (claims as Record<string, unknown>).name;
    const token = makeToken(baseHeader(), {
      ...claims,
      preferred_username: "caller@example.com",
    });

    const result = await validateEntraToken(token);

    expect((result as { principal: { displayName: string } }).principal.displayName)
      .toBe("caller@example.com");
  });

  it("emits an overage warning and returns groups=[] when _claim_names.groups is present", async () => {
    const token = makeToken(baseHeader(), {
      ...baseClaims(),
      groups: ["should-be-ignored"],
      _claim_names: { groups: "src1" },
    });

    const result = await validateEntraToken(token);

    expect((result as { principal: { groups: string[] } }).principal.groups)
      .toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      "auth.entra.groups_overage",
      expect.objectContaining({ provider: "entra", userId: "user-oid-1" }),
    );
  });

  it("filters non-string entries from the groups array", async () => {
    const token = makeToken(baseHeader(), {
      ...baseClaims(),
      groups: ["g1", 42, null, "g2"],
    });

    const result = await validateEntraToken(token);

    expect((result as { principal: { groups: string[] } }).principal.groups)
      .toEqual(["g1", "g2"]);
  });
});
