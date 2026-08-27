# Monitor Sources and Fintech GC Preset

MikeOSS Monitors can combine three source paths in one scheduled agent:

- RSS or Atom feeds.
- HTTPS web pages watched for content changes.
- Any enabled MCP connector with unattended tools.

Source fetching and model analysis are separate. Feed and page retrieval uses bounded concurrency; model calls and committee members use the configured sequential orchestration. Feed items are marked processed only after a successful analysis.

Monitoring is the product feature. Trademark Prefix Watch and Fintech GC
Regulatory Digest are environment-specific templates within Monitoring, not
independent account features. Trademark Prefix Watch appears automatically
when an enabled compatible USPTO connector exposes its unattended trademark
search tool. The Fintech template is opt-in for an instance; set
`LEGAL_MONITOR_FINTECH_PRESET_ENABLED=true` to expose it. Vanilla MikeOSS
deployments leave that setting false.

## Create a Trademark Prefix Watch

The managed **USPTO Patent & Trademark** connector must be enabled and its `tm_search_trademarks` tool must be enabled without confirmation.

1. Open **Monitors**.
2. Select **Trademark Prefix Watch**.
3. Enter the word or phrase under **Mark begins with**.
4. Select live, dead, or all registrations and optionally narrow the watch to a Nice class.
5. Select the analysis model or committee, leave the frequency at **Daily**, and save. The searchable selector uses the same configured model catalog as chat, including OpenRouter models when an OpenRouter key is configured.
6. Use **Run now** to process the initial lookback window.

This mode calls the connector directly; the analysis model does not need function-calling support. Mike constructs a fielded prefix query plus a `registrationDate` window. The first run uses the configured initial lookback. Later runs overlap the last completed run's date and use the SQLite observation queue to remove duplicates.

Only records with a registration date and a returned word mark that actually begins with the configured text are accepted. Pending records are marked processed only after analysis succeeds. A run scans at most 250 matching registrations; narrow a broad prefix by Nice class when the connector reports more.

## Use Other Connectors

Select an enabled connector under **Connector source** and leave **Retrieval mode** set to **Agent-directed research**. Mike exposes that connector's enabled unattended tools to the retrieval model and requires at least one successful connector call before analysis. Use a model with function-calling support for this mode.

Connector tools that require per-call confirmation are intentionally excluded from scheduled runs. A connector-specific deterministic mode can be added for repeatable searches that should work with local models lacking function calling; the trademark-prefix mode is the first such adapter.

## Create the Fintech GC Digest

1. Open **Monitors**.
2. Select **Fintech GC Regulatory Digest**.
3. Select the analysis model or committee.
4. Optionally select a DingDuff connector. The preset's 33 RSS/Atom feeds work without DingDuff; selecting it in agent-directed mode adds case-law and statutory research.
5. Review the daily schedule, 14-day initial lookback, 50-item run limit, and alert email.
6. Save the monitor and use **Run now** for the first intake.

The preset includes the federal banking regulator, Federal Register, state regulator, payments press, AI, and cybersecurity feeds from `fintech_gc_digest_feeds.opml`. Its analysis instructions apply the relevance, urgency, business-line, required-action, policy-gap, and GC briefing framework from `MikeOSS_Fintech_GC_Digest_Build_Guide.md`.

All 33 preset URLs were fetched and parsed successfully as RSS or Atom during implementation validation on July 29, 2026. Sources can change independently after that date; per-source health and errors are therefore shown in the monitor rather than causing successful sources to be discarded.

## Import OPML

Open a new or existing monitor, select **Import OPML**, and choose an `.opml` or `.xml` file. MikeOSS retains OPML folders as source categories and rejects duplicate or non-HTTPS feed URLs.

## Add Other Sources

Select **Source** in the monitor editor, then choose:

- **RSS / Atom** for an XML feed URL.
- **Web page** for an HTTPS page that should produce a new item whenever its normalized content changes.

Each source records its last check, last successful check, current error, ETag, Last-Modified value, and item count. Source errors appear on the monitor and run report without discarding successfully retrieved items from other sources.

## Add Library Context

Open a new or existing monitor and select **Add files** under **Library
context**. A monitor can reference up to 10 ready files from **Library >
Files**. Mike reads each file's active version when the monitor runs, so a
later Library edit is picked up without reattaching the file.

Library files are background for interpreting terminology, obligations, risk
posture, and materiality. They are not monitor discoveries, cannot create an
alert by themselves, and must not be cited as the source of a new development.
Scheduled runs include at most 12,000 characters from one file and 40,000
characters across all referenced files.

## Processing Rules

- The first run accepts entries inside the configured lookback window.
- Later runs analyze unprocessed new or changed entries.
- URL/GUID identity and content hashes prevent duplicate processing.
- A failed analysis leaves items pending for the next run.
- RSS and web content is treated as untrusted evidence, not model instructions.
- Configured URLs must use HTTPS and cannot resolve to private, loopback, link-local, or cloud metadata addresses.
- DingDuff is used directly when configured. The monitor pipeline does not substitute CourtListener for DingDuff.
- Deterministic connector observations are stored in `legal_monitor_connector_items` and included in account export/deletion.
- Library associations are stored in `legal_monitor_documents` and included in account export/deletion.

## Sources Without Public Feeds

Email/GovDelivery-only material can be added when it is exposed through an approved HTTPS feed or connector. Card-network portals, membership-only sources, and periodically replaced PDFs can be represented as watched web pages when public access is stable. Authenticated inbox ingestion and authenticated PDF-diff adapters require dedicated connectors and are not implied by the RSS importer.
