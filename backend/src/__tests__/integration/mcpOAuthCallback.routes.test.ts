import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../app";

describe("GET /user/mcp-connectors/oauth/callback", () => {
  it("escapes attacker-controlled error text so it cannot break out of the script block", async () => {
    const response = await request(app)
      .get("/user/mcp-connectors/oauth/callback")
      .query({
        error: '</script><meta http-equiv="refresh" content="0;url=https://evil.example">',
        state: "state-token",
        code: "code",
      })
      .expect(400);

    expect(response.headers["content-type"]).toContain("text/html");
    // The callback now sanitizes the detail before it is ever embedded, so
    // attacker-controlled text does not reach the page at all. The "<" ->
    // \u003c escaping in buildOAuthResultPage remains as defense in depth for
    // any field that does carry user input.
    expect(response.text).not.toContain("</script><meta");
    expect(response.text).not.toContain("evil.example");
    expect(response.text).toContain(
      "Connector authorization could not be completed.",
    );
    expect(response.headers["content-security-policy"]).toContain(
      "script-src 'nonce-",
    );
  });

  it("returns the failure popup when state or code are missing", async () => {
    const response = await request(app)
      .get("/user/mcp-connectors/oauth/callback")
      .expect(400);
    expect(response.text).toContain("Authorization failed");
  });
});
