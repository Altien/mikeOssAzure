# Enabling The USPTO Patent And Trademark MCP Server

Mike includes a managed connector for
[`riemannzeta/patent_mcp_server`](https://github.com/riemannzeta/patent_mcp_server).
The backend launches version `0.9.5` locally over MCP stdio using Python 3.13
and the MCP Python SDK 1.x compatibility line. It does not expose an arbitrary
command field in the web interface.

## Quick Start

1. Install [`uv`](https://docs.astral.sh/uv/getting-started/installation/) on
   the machine running the Mike backend, and confirm both commands are visible
   to the same operating-system user that runs Mike:

   ```bash
   uv --version
   uvx --version
   ```

2. Restart the Mike backend if it was already running when you installed `uv`.
3. Sign in to Mike, open **Account > Connectors**, and select **USPTO**.
4. Wait for provisioning to finish. On first launch, `uvx` downloads a managed
   Python 3.13 build (about 33 MB) and the server's packages into
   `backend/data/uv`; with a normal connection this takes about a minute.
   Later launches use the cache and start in seconds.
5. Open the **USPTO Patent & Trademark** connector details and review the
   imported tool catalog — the pinned server currently publishes **52 tools**
   over MCP (patent search, CPC lookup, trademark search, assignments, status
   codes, and more). Disable any tools you do not want exposed to assistant
   conversations.

No API keys are needed for the public tools. The server logs a warning at
startup when `USPTO_API_KEY` is not set — that is expected, and only means the
credentialed Open Data Portal tools will return 403 until a key is added.

## Exact Trademark Owner Searches

For a trademark portfolio search, pass the complete legal owner name through
the `owner_name` argument to `tm_search_trademarks`. Do not put an owner name in
the generic `query` argument: USPTO treats that as a broad/advanced search and
can match words in marks and owner-address data.

For a bulk portfolio search, pass up to 10 complete legal names through the
`owner_names` array in one tool call. Mike reuses one managed connector session
and sends owner searches through a paced serial queue with 2.5 seconds between
requests. HTTP 429 responses are retried after 10, 20, and 30 seconds. If
throttling continues, the result preserves completed portfolios and returns
`failed_owner_names`; stop the current search, wait at least 60 seconds, and
retry only those names in a new request without repeating successful searches.
If a model emits several separate owner-name searches in one response, Mike
collapses them into this bulk form automatically.

For the managed USPTO connector, Mike treats `owner_name` as an exact current
owner search. It requests owner-field candidates, follows pagination, and then
compares the returned `ownerName` values after normalizing case, punctuation,
and whitespace. Corporate suffixes remain significant, so `Example LLC` does
not match `Example Inc.` The response metadata reports how many upstream
candidates were examined and whether the search was exhaustive. Candidate
sets above 1,000 records are stopped with an explicit incomplete-results
warning rather than silently presenting a partial portfolio as complete.

Mike retrieves owner candidates in lossless 10-record pages and paces those
pages one second apart. The final response uses a compact portfolio projection
(serial and registration numbers, mark, owner, status, classes, key dates, and
a short goods/services summary), so large portfolios remain complete instead
of being cut off by the model-context response limit. Exact-owner searches
return up to 100 marks by default; use `offset` only for portfolios above 100.

## Verify The Server Outside Mike (optional)

To isolate download or network problems from Mike, run the exact pinned
command as the backend service user:

```bash
uvx --python 3.13 --from patent-mcp-server==0.9.5 --with 'mcp[cli]>=1.28,<2' patent-mcp-server
```

A successful launch prints the server configuration and
`Starting USPTO Patent MCP server with stdio transport`, then waits for MCP
messages on stdin. Exit with Ctrl-C.

## Optional USPTO Credentials

Public Patent Public Search (PPUBS), trademark search, and trademark assignment
tools work without API keys. Add keys to `backend/.env` to enable the server's
credentialed data sources:

```bash
# USPTO Open Data Portal tools (register at https://data.uspto.gov,
# then visit "My ODP" to create a key)
USPTO_API_KEY=replace-with-your-uspto-odp-key

# TSDR trademark status and document tools
TSDR_API_KEY=replace-with-your-uspto-tsdr-key

# Optional, only when the trademark-search endpoint requires a WAF token
TMSEARCH_WAF_TOKEN=replace-with-your-waf-token
```

Because the WAF token is temporary, trademark searches may begin failing again
with HTTP 202/403 or `WAF_CHALLENGE`. Follow
[Renewing the USPTO Trademark Search WAF Token](tmsearch-waf-token.md) for the
browser renewal, local configuration, restart, and verification procedure.

Restart the backend after changing environment variables. Mike passes only the
MCP SDK's safe default environment and the connector's documented settings to
the child process. Credentials are not stored in connector rows or returned to
the browser.

## How Mike Runs The Server

Provisioning is idempotent: selecting **USPTO** again refreshes the same
connector instead of creating a duplicate. Tool refreshes preserve your prior
enabled/disabled selections. Tools marked destructive or non-read-only by the
server remain disabled under Mike's existing confirmation policy.

The `uv` cache, tool environments, and any managed Python installs are
contained in `backend/data/uv` by default so the connector works for service
accounts with read-only home directories. Override the location with
`PATENT_MCP_UV_DATA_DIR` in `backend/.env` if needed.

Without a local checkout configured, Mike runs:

```bash
uvx --python 3.13 \
  --from patent-mcp-server==0.9.5 \
  --with 'mcp[cli]>=1.28,<2' \
  patent-mcp-server
```

The explicit Python and MCP SDK constraints are required. Version `0.9.5`
imports the v1 `mcp.server.fastmcp` module and declares Python `<3.14`, but its
published dependency metadata does not exclude the incompatible MCP SDK 2.x.

An imported tool can be present even when its underlying USPTO service has
been retired upstream; the upstream README tracks which tools are active.

## Run From A Local Checkout

For development, Mike can run a checked-out copy instead of the pinned PyPI
artifact:

```bash
git clone https://github.com/riemannzeta/patent_mcp_server.git
cd patent_mcp_server
git checkout v0.9.5
uv sync
```

Clone it anywhere outside the repo (or under `backend/vendor/`, which is
gitignored), then set the absolute checkout path in `backend/.env`:

```bash
PATENT_MCP_DIRECTORY=/absolute/path/to/patent_mcp_server

# Optional uv data override; the backend service user must be able to write here
PATENT_MCP_UV_DATA_DIR=/absolute/path/to/a/writable/uv-data-directory
```

Restart the backend and select **USPTO** again to refresh the tool catalog.
Mike will run:

```bash
uv --directory "$PATENT_MCP_DIRECTORY" run \
  --python 3.13 \
  --with 'mcp[cli]>=1.28,<2' \
  patent-mcp-server
```

## Troubleshooting

**The preset request says `spawn uvx ENOENT`.** Install `uv`, make sure `uvx`
is on the backend service user's `PATH`, and restart that service.

**Setup times out on the first attempt.** Run the pinned `uvx` command from
[Verify The Server Outside Mike](#verify-the-server-outside-mike-optional)
once as the backend service user, then retry. This isolates package download or
network failures from Mike.

**Some tools fail with an API-key message.** Configure the matching key above.
`USPTO_API_KEY` and `TSDR_API_KEY` are separate credentials.

**A retired tool fails.** Disable it in connector details. The upstream README
tracks active and unavailable tools.

**No tools appear.** Open the connector details and use **Refresh tools** after
checking the backend logs. The connector can be disabled, but managed local
connectors cannot be deleted or repointed from the browser.

## Upstream References

- [Source and server configuration](https://github.com/riemannzeta/patent_mcp_server)
- [Published Python package](https://pypi.org/project/patent-mcp-server/)
