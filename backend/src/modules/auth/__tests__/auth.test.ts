import { describe, expect, it } from "vitest";
import { credentialsSchema, signupSchema, passwordSchema } from "../auth.service";

// Dev divergence (sync-log: c94052d7): route transport is opaque server sessions;
// pin the shared policy without reviving upstream's retired cookie-client harness.
describe("password policy", () => {
  it.each(["eightch8", "x", "a".repeat(80), "😀".repeat(19)])("accepts legacy sign-in passwords: %s", password => {
    expect(credentialsSchema.safeParse({ email: "person@example.test", password }).success).toBe(true);
  });
  it.each([["a", 72], ["é", 36], ["密", 24], ["😀", 18], ["é", 24]] as const)("counts UTF-8 bytes for %s", (unit, count) => {
    for (const schema of [signupSchema, passwordSchema]) {
      expect(schema.safeParse({ email: "person@example.test", password: unit.repeat(count) }).success).toBe(true);
      expect(schema.safeParse({ email: "person@example.test", password: unit.repeat(count + 1) }).success).toBe(false);
    }
  });
  it("applies the new minimum to passwords being set", () => {
    expect(signupSchema.safeParse({ email: "person@example.test", password: "eightch8" }).success).toBe(false);
    expect(passwordSchema.safeParse({ password: "short" }).success).toBe(false);
  });
});
