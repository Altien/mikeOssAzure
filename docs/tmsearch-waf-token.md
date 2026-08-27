# Renewing the USPTO Trademark Search WAF Token

Mike's managed USPTO connector uses the internal search service behind
[`tmsearch.uspto.gov`](https://tmsearch.uspto.gov/). USPTO protects that
service with AWS WAF. When WAF begins rejecting automated requests, Mike needs
a valid token issued by the USPTO site to a real browser session.

The token is temporary. Repeat this procedure whenever trademark searches
start returning an AWS WAF, HTTP 202, HTTP 403, `WAF_CHALLENGE`, or
`TMSEARCH_WAF_TOKEN` error.

## 1. Obtain a fresh token

Use a browser on the same machine or network as the Mike backend when
possible. AWS WAF can associate tokens with browser and network characteristics,
so a token acquired on an unrelated remote network might not work.

1. Open [USPTO Trademark Search](https://tmsearch.uspto.gov/) in Chrome or
   Edge.
2. Complete any challenge shown by USPTO.
3. Run an ordinary trademark search and wait for its results.
4. Open Developer Tools:
   - Chrome/Edge on Windows or Linux: `F12` or `Ctrl+Shift+I`.
   - Chrome/Edge on macOS: `Command+Option+I`.
5. Select **Application**.
6. Under **Storage**, expand **Cookies** and select
   `https://tmsearch.uspto.gov`.
7. Find the cookie named `aws-waf-token` and copy its complete **Value**.

If the cookie is absent, open the **Console** while still on the USPTO page and
run:

```javascript
await AwsWafIntegration.getToken();
```

Return to **Application > Cookies**, refresh the cookie list, and copy the new
`aws-waf-token` value.

## 2. Configure Mike

Open `backend/.env` and add or replace this line:

```dotenv
TMSEARCH_WAF_TOKEN=paste-the-complete-cookie-value-here
```

Important:

- Keep the value on one line.
- Do not add spaces around `=`.
- Do not paste the entire `Cookie:` header; use only the value of the
  `aws-waf-token` cookie.
- Treat the token as a secret. Do not put it in chat messages, screenshots,
  commits, issue reports, or `backend/.env.example`.
- `backend/.env` is local configuration and must remain uncommitted.

## 3. Restart the local backend

Mike is running locally with npm, not Docker. Stop the existing backend process
with `Ctrl+C`, then run:

```bash
cd /home/dwmcqueen/Projects/mike
npm run dev --prefix backend
```

Only the backend needs restarting. The managed USPTO connector receives the
new token the next time Mike launches it for a tool call.

## 4. Verify the repair

Start a new Assistant chat and make a narrow test request, for example:

> Find trademarks whose exact current owner is Family First Life, LLC.

A successful response should contain exact-owner results without an HTTP 202,
HTTP 403, WAF challenge, or token error. After that succeeds, retry the larger
portfolio search.

## Troubleshooting

### A fresh token is still rejected

Check the following:

1. Confirm that `backend/.env` contains exactly one active
   `TMSEARCH_WAF_TOKEN` entry.
2. Confirm that the complete cookie value was copied without truncation or
   surrounding quotation marks.
3. Confirm that the backend was fully stopped and restarted after editing the
   environment file.
4. Generate the token from a browser using the same network egress as the
   backend. This especially matters when Mike runs on another server, through
   a VPN, or behind a proxy.
5. Open the USPTO site again, complete any new challenge, and acquire another
   token. The site controls token validity and can invalidate a token before
   its expected lifetime.

### The browser console says `AwsWafIntegration` is undefined

Reload the USPTO search page, wait for it to finish loading, perform a search,
and try again. Also check **Application > Cookies** first—the site may already
have created the cookie without exposing the JavaScript helper globally.

### Trademark search works without a token

The token is optional while USPTO permits plain requests. If an old configured
token appears to cause failures, remove the `TMSEARCH_WAF_TOKEN` line, restart
the backend, and run the narrow test again. If WAF rejects the tokenless
request, obtain a fresh token using this runbook.

### The response says HTTP 429 or rate-limited

HTTP 429 is a request-rate limit, not an expired WAF token. Regenerating
`TMSEARCH_WAF_TOKEN` will not resolve it. Mike automatically retries the same
search after 10, 20, and 30 seconds and paces bulk owner searches at one request
every 2.5 seconds. If USPTO is still throttling, Mike returns
`failed_owner_names`; stop the current search, wait at least 60 seconds, and
retry only those owners in a new request. Successfully completed owner
portfolios do not need to be searched again.

### The error is not a WAF error

Do not renew the token for ordinary search validation errors, empty exact-owner
results, model timeouts, or malformed model tool calls. Token renewal is
appropriate for WAF challenge messages and HTTP 202/403 responses from
`tmsearch.uspto.gov`.

## Why renewal cannot be fully automatic

AWS WAF issues the token after a browser completes a silent challenge or, when
required, a CAPTCHA. The backend cannot safely synthesize that proof, and
Mike's web application cannot read cookies belonging to the separate USPTO
domain. Manual browser renewal preserves the protection boundary instead of
attempting to bypass it.

For general connector setup and tool configuration, see
[Enabling the USPTO Patent and Trademark MCP Server](patent-mcp-connector.md).
