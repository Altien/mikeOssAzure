import { afterEach, describe, expect, it, vi } from "vitest";
import { startSupabaseSSO } from "../auth/providers/supabaseSession";

// Dev drift: upstream's lib/authSession (createRequestSupabase + a cookie-held
// PKCE verifier) does not exist in Dev. Dev's opaque server session starts SSO
// via startSupabaseSSO, which returns the verifier as server-side state that
// auth.routes stores with the OAuth state row (only a browser nonce cookie is
// set). The PKCE contract with GoTrue is unchanged and asserted below.
// Exercise the real Auth SDK; only the upstream HTTP boundary is mocked.
describe("SSO PKCE session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends a PKCE challenge and returns the verifier as server-held state for the callback", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_URL", "https://auth.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-key");
    const upstream = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "https://idp.example/saml" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", upstream);

    const { url: idpUrl, verifierState } = await startSupabaseSSO(
      "example.com",
      "https://app.example.test/auth/callback",
    );

    expect(idpUrl).toBe("https://idp.example/saml");
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://auth.example.test/auth/v1/sso");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      domain: "example.com",
      skip_http_redirect: true,
      code_challenge_method: "s256",
    });
    expect(body.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.redirect_to).toContain(
      "https://app.example.test/auth/callback",
    );
    const stored = JSON.parse(verifierState) as Record<string, string>;
    const verifierKey = Object.keys(stored).find((key) =>
      key.endsWith("-code-verifier"),
    );
    expect(verifierKey).toBeDefined();
    expect(stored[verifierKey!]).toBeTruthy();
  });
});
