import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { createHmac } from "node:crypto";
import { validateLocalToken } from "./local";

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function sign(headerB64: string, payloadB64: string, secret: string): string {
  return b64url(
    createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest(),
  );
}

function makeToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  secret: string,
): string {
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  const s = sign(h, p, secret);
  return `${h}.${p}.${s}`;
}

const SECRET = "test-secret-do-not-use-in-prod";
const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;
const PAST = () => Math.floor(Date.now() / 1000) - 3600;

const envSnapshot = {} as Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot.JWT_SECRET = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
});

afterEach(() => {
  if (envSnapshot.JWT_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = envSnapshot.JWT_SECRET;
});

describe("validateLocalToken — configuration", () => {
  it("rejects with 401 when JWT_SECRET is not configured", async () => {
    delete process.env.JWT_SECRET;

    const result = await validateLocalToken(
      makeToken({ alg: "HS256", typ: "JWT" }, { sub: "u", exp: FUTURE() }, SECRET),
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Server auth is not configured",
    });
  });
});

describe("validateLocalToken — structural failures", () => {
  it("rejects a token that doesn't have exactly three dot-separated parts", async () => {
    expect(await validateLocalToken("only.two")).toEqual({
      ok: false,
      status: 401,
      detail: "Malformed JWT",
    });
    expect(await validateLocalToken("a.b.c.d")).toEqual({
      ok: false,
      status: 401,
      detail: "Malformed JWT",
    });
    expect(await validateLocalToken("solid-mass")).toEqual({
      ok: false,
      status: 401,
      detail: "Malformed JWT",
    });
  });

  it("rejects with 'Malformed JWT header' when the header isn't valid base64-JSON", async () => {
    const result = await validateLocalToken("not-json!.payload.sig");

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Malformed JWT header",
    });
  });

  it("rejects with 'Malformed JWT payload' when only the payload is corrupt", async () => {
    const h = b64url(Buffer.from(JSON.stringify({ alg: "HS256" })));
    const badPayload = "not-base64-json!";
    const s = sign(h, badPayload, SECRET);
    const token = `${h}.${badPayload}.${s}`;

    const result = await validateLocalToken(token);

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Malformed JWT payload",
    });
  });
});

describe("validateLocalToken — algorithm enforcement (alg-confusion guard)", () => {
  it("rejects alg=none", async () => {
    const h = b64url(Buffer.from(JSON.stringify({ alg: "none" })));
    const p = b64url(Buffer.from(JSON.stringify({ sub: "u", exp: FUTURE() })));
    const token = `${h}.${p}.`;

    const result = await validateLocalToken(token);

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Unsupported alg: none",
    });
  });

  it("rejects alg=RS256 even when a valid HS256 signature is supplied — the verifier must trust the header alg only after whitelisting it", async () => {
    const h = b64url(Buffer.from(JSON.stringify({ alg: "RS256" })));
    const p = b64url(Buffer.from(JSON.stringify({ sub: "u", exp: FUTURE() })));
    const s = sign(h, p, SECRET);
    const token = `${h}.${p}.${s}`;

    const result = await validateLocalToken(token);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/Unsupported alg: RS256/);
  });

  it("rejects a token whose header omits the alg field entirely", async () => {
    const h = b64url(Buffer.from(JSON.stringify({ typ: "JWT" })));
    const p = b64url(Buffer.from(JSON.stringify({ sub: "u", exp: FUTURE() })));
    const s = sign(h, p, SECRET);
    const token = `${h}.${p}.${s}`;

    const result = await validateLocalToken(token);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/Unsupported alg/);
  });
});

describe("validateLocalToken — signature verification", () => {
  it("rejects a token signed with a different secret", async () => {
    const token = makeToken(
      { alg: "HS256" },
      { sub: "u", exp: FUTURE() },
      "wrong-secret",
    );

    const result = await validateLocalToken(token);

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Invalid signature",
    });
  });

  it("rejects a token whose payload was modified after signing", async () => {
    const original = makeToken(
      { alg: "HS256" },
      { sub: "u", exp: FUTURE() },
      SECRET,
    );
    const [h, , s] = original.split(".");
    const tampered = b64url(
      Buffer.from(JSON.stringify({ sub: "attacker", exp: FUTURE() })),
    );

    const result = await validateLocalToken(`${h}.${tampered}.${s}`);

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Invalid signature",
    });
  });

  it("rejects a signature of the wrong length without throwing (timingSafeEqual must be guarded)", async () => {
    const h = b64url(Buffer.from(JSON.stringify({ alg: "HS256" })));
    const p = b64url(Buffer.from(JSON.stringify({ sub: "u", exp: FUTURE() })));
    const shortSig = b64url(Buffer.from([0x01, 0x02, 0x03]));
    const token = `${h}.${p}.${shortSig}`;

    const result = await validateLocalToken(token);

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Invalid signature",
    });
  });
});

describe("validateLocalToken — claim validation", () => {
  it("rejects a token missing the sub claim", async () => {
    const token = makeToken({ alg: "HS256" }, { exp: FUTURE() }, SECRET);

    const result = await validateLocalToken(token);

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Token missing sub claim",
    });
  });

  it("rejects a non-string sub claim (numeric ids are not accepted)", async () => {
    const token = makeToken(
      { alg: "HS256" },
      { sub: 42, exp: FUTURE() },
      SECRET,
    );

    const result = await validateLocalToken(token);

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Token missing sub claim",
    });
  });

  it("rejects a token missing the exp claim", async () => {
    const token = makeToken({ alg: "HS256" }, { sub: "u" }, SECRET);

    const result = await validateLocalToken(token);

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Token missing exp claim",
    });
  });

  it("rejects an exp claim that isn't a number (e.g. a stringified epoch)", async () => {
    const token = makeToken(
      { alg: "HS256" },
      { sub: "u", exp: String(FUTURE()) },
      SECRET,
    );

    const result = await validateLocalToken(token);

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Token missing exp claim",
    });
  });

  it("rejects a token whose exp is in the past", async () => {
    const token = makeToken(
      { alg: "HS256" },
      { sub: "u", exp: PAST() },
      SECRET,
    );

    const result = await validateLocalToken(token);

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Token expired",
    });
  });
});

describe("validateLocalToken — success", () => {
  it("returns a principal with sub→userId, lowercased email, tid→tenantId, groups, roles", async () => {
    const token = makeToken(
      { alg: "HS256" },
      {
        sub: "user-1",
        email: "Caller@Example.COM",
        tid: "tenant-1",
        groups: ["g1", "g2"],
        roles: ["Member"],
        exp: FUTURE(),
      },
      SECRET,
    );

    const result = await validateLocalToken(token);

    expect(result).toEqual({
      ok: true,
      principal: {
        userId: "user-1",
        email: "caller@example.com",
        tenantId: "tenant-1",
        groups: ["g1", "g2"],
        roles: ["Member"],
        provider: "local",
      },
    });
  });

  it("filters non-string entries out of the groups and roles arrays", async () => {
    const token = makeToken(
      { alg: "HS256" },
      {
        sub: "u",
        exp: FUTURE(),
        groups: ["g1", 42, null, "g2"],
        roles: ["Member", true],
      },
      SECRET,
    );

    const result = await validateLocalToken(token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.groups).toEqual(["g1", "g2"]);
      expect(result.principal.roles).toEqual(["Member"]);
    }
  });

  it("defaults email/tenantId/groups/roles to safe values when claims are absent", async () => {
    const token = makeToken(
      { alg: "HS256" },
      { sub: "u", exp: FUTURE() },
      SECRET,
    );

    const result = await validateLocalToken(token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.email).toBe("");
      expect(result.principal.tenantId).toBeUndefined();
      expect(result.principal.groups).toEqual([]);
      expect(result.principal.roles).toEqual([]);
    }
  });

  it("does not leak the JWT secret into the result", async () => {
    const token = makeToken(
      { alg: "HS256" },
      { sub: "u", exp: FUTURE() },
      SECRET,
    );

    const result = await validateLocalToken(token);

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
