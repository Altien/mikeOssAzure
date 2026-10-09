import { z } from "zod";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_TOO_LONG_DETAIL } from "./auth.messages";
import { getConfig } from "../../lib/config";

/** Resolve the configured identity provider without probing optional GoTrue. */
export async function authProvider(): Promise<string> {
  return (await getConfig("auth-provider").catch(() => process.env.AUTH_PROVIDER || "supabase")) || "supabase";
}

// Upstream c94052d7: password policy applies only to the supported password provider.
export const emailSchema = z.string().trim().email().max(320);

/**
 * The 72 is bcrypt's limit on its INPUT IN BYTES, not in characters. A
 * `.max(72)` here counts UTF-16 code units, so a 60-character passphrase
 * with accents or an emoji passes this check and is then rejected by
 * GoTrue — the failure a user cannot explain. The clients count the same
 * bytes (`isPasswordTooLong` in frontend/src/app/components/auth/
 * passwordPolicy.ts), so both sides agree on which passwords are legal.
 *
 * The character cap that remains is only a work bound: anything that hits
 * it is over the byte limit too, and gets the same sentence.
 */
const PASSWORD_CHARACTER_GUARD = 1024;

function passwordField(minimumCharacters: number) {
  return z
    .string()
    .min(minimumCharacters)
    .max(PASSWORD_CHARACTER_GUARD)
    .superRefine((value, ctx) => {
      if (Buffer.byteLength(value, "utf8") <= PASSWORD_MAX_LENGTH) return;
      ctx.addIssue({
        code: "too_big",
        origin: "string",
        maximum: PASSWORD_MAX_LENGTH,
        inclusive: true,
        message: PASSWORD_TOO_LONG_DETAIL,
      });
    });
}

/**
 * Sign-in validates presence only. The policy (10 characters, 72 bytes)
 * governs passwords we are about to SET; an existing account may hold one
 * set under main's earlier 8-character rule, by an admin, or before GoTrue
 * refused >72 bytes (bcrypt compares only the first 72, so it still
 * matches). Rejecting those here would lock their owners out with a
 * message telling them to change a password they cannot reach. GoTrue is
 * the only judge of a match; the 4096 cap is just a request-size bound.
 */
export const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(4096),
});
/** Sign-up applies the length policy; login accepts whatever was set. */
export const signupSchema = credentialsSchema.extend({
  password: passwordField(PASSWORD_MIN_LENGTH),
});

export const passwordSchema = z.object({ password: passwordField(PASSWORD_MIN_LENGTH), nonce: z.string().optional() });
