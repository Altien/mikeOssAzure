#!/usr/bin/env node
// Mint a local-dev HS256 JWT that PostgREST will accept.
//
// Usage:
//   JWT_SECRET=<secret> node scripts/local-stack/forge-jwt.mjs \
//     --role authenticated --sub <uuid> --hours 8
//
// Defaults: role=authenticated, sub=00000000-0000-0000-0000-000000000001,
// hours=8.
//
// Standard library only — no node_modules needed.

import { createHmac } from "node:crypto";
import { argv, env, exit } from "node:process";

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const secret = env.JWT_SECRET;
if (!secret) {
  console.error("JWT_SECRET env var must be set (must match PGRST_JWT_SECRET).");
  exit(1);
}

const role = arg("role", "authenticated");
const sub = arg("sub", "00000000-0000-0000-0000-000000000001");
const hours = Number(arg("hours", "8"));

const header = { alg: "HS256", typ: "JWT" };
const now = Math.floor(Date.now() / 1000);
const payload = {
  role,
  sub,
  iat: now,
  exp: now + hours * 3600,
};

const b64url = (buf) =>
  Buffer.from(buf)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const signingInput =
  b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(payload));
const sig = b64url(createHmac("sha256", secret).update(signingInput).digest());

console.log(signingInput + "." + sig);
