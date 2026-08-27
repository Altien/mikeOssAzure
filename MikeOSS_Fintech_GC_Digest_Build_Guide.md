# Building the GC Fintech Regulatory Digest Agent on MikeOSS

This adapts the [Fintech GC Digest Regulatory & Trade Feed Sources](/) (`Fintech_GC_Digest_Regulatory_Feed_Sources.md` / `fintech_gc_digest_feeds.opml`) into build instructions for a bank/credit-union core-processing and digital-payments technology vendor — "a company like Jack Henry & Associates" — running the same classify → gap-check → memo-draft → digest pipeline on **MikeOSS** ([Open-Legal-Products/mike](https://github.com/Open-Legal-Products/mike)) that was previously built for the insurance/IMO-FMO use case.

The MikeOSS architecture, API contracts, and DingDuff positioning below are identical to the insurance-sector build (all facts were verified directly against MikeOSS source code and DingDuff's own site on 2026-07-29 — see the [insurance build guide](/) for the full verification detail and file/line citations). This document focuses on what's *different* for the fintech/payments vertical: the business-line taxonomy, the relevance model, and the project/company context.

## 1. What's the same as the insurance build

- MikeOSS now has native RSS/Atom and watched-page ingestion, SQLite checkpoints, scheduling, reports, email alerts, OPML import, and source-health tracking in **Monitors**. The external orchestration script in the bundle is retained only as a historical prototype.
- DingDuff is callable by scheduled monitors through a configured user MCP connector. When selected, monitor retrieval uses DingDuff and does not fall back to CourtListener. RSS-only monitors do not require a DingDuff connector.
- All seven verified backend API routes are unchanged (`GET/POST /projects`, `POST /projects/:projectId/documents`, `GET/POST /workflows`, `POST /tabular-review`, `POST /tabular-review/:reviewId/generate`, `GET /tabular-review/:reviewId`, `POST /chat`) — see the table in §4 below, reproduced from the verified source.
- The `table-columns.yaml` schema rules are unchanged (`format` ∈ `text | date | monetary_amount | percentage | bulleted_list | yes_no | tag`; `tags` required iff `format == "tag"`).

## 2. What's different for fintech/payments

### 2a. Business context this classifier is tuned for

A company like Jack Henry sits in three regulatory postures simultaneously, which is why the classifier's **Relevance** column uses a 3-way "Direct/Direct/Indirect" split instead of the insurance version's simpler "Directly/Indirectly Applicable":

1. **Direct — Vendor Obligation**: the company itself must comply (e.g. a payment-network rule change, a cybersecurity control mandate).
2. **Direct — Examined as Bank Service Provider**: federal banking-agency examination guidance applies to the company's own operations, since it's examined under the **Bank Service Company Act (BSCA)** as a bank service company/critical technology provider.
3. **Indirect — Client Institution Obligation**: the requirement legally falls on the client bank/credit union, but the company's software must be updated to help clients comply (e.g. a new CFPB open-banking data-sharing API standard, a new disclosure requirement in digital banking).

This structure was informed by Jack Henry's own patent/business-line profile: core clusters in Remote Check Deposit, Transaction Risk Management on a Network (from the 2017 Ensenta acquisition), and Remote Deposit Image Handling, plus a newest-generation multimodal AI/ML fraud-detection patent (filed January 2025) — reflecting where AI/model-risk guidance will land hardest.

### 2b. Tabular workflow: Fintech Regulatory Alert Classifier

Full, unabridged files are in the shared bundle at `mikeoss-fintech-gc-digest/tabular-review-workflows/fintech-regulatory-alert-classifier/`. Nine columns:

| # | Column | Format | Key tags |
|---|---|---|---|
| 0 | Headline | text | — |
| 1 | Source & Date | text | — |
| 2 | Affected Product / Business Line(s) | tag | Core Banking/Processing, Digital & Mobile Banking, Remote Deposit Capture, Payments Processing (ACH/Wire/RTP/FedNow), Card & Payment Network Connectivity, Fraud/AML & Transaction Risk Management, AI/ML Models, Open Banking/Data-Sharing APIs, Cybersecurity/Data Privacy, Cross-Cutting/Enterprise-Wide, Not Applicable |
| 3 | Relevance | tag | Direct — Vendor Obligation, Direct — Examined as Bank Service Provider, Indirect — Client Institution Obligation, Monitor Only, Not Relevant |
| 4 | Urgency Level | tag | Critical, High, Medium, Low |
| 5 | Required Action Type | tag | Policy Update, Board Memo, Product/Engineering Change, Client Communication, Training, Legal Review, Contract/Network Agreement Update, No Action Required |
| 6 | Summary of Requirement | text | — |
| 7 | Possible Policy Gap | yes_no | — |
| 8 | Effective/Deadline Date | date | — |

`SKILL.md` frontmatter: `mike-type: "tabular"`, `practice: "Banking / Payments Regulatory / Compliance"`, `jurisdictions: "Federal, All U.S. States"`.

### 2c. Assistant workflow: GC Fintech Briefing Memo

Same one-page template as the insurance version (Headline / Why It Matters / Recommended Action / Timeline / Owner / Next Steps), with two additions specific to this vertical:

- An explicit **Relevance** line at the top of the memo, so the GC can immediately see whether this is a direct vendor obligation, a bank-service-provider examination matter, or a client-institution pass-through.
- Explicit instructions for "Indirect — Client Institution Obligation" items: the memo must state whether/how client banks and credit unions need to be notified, and whether a product/API change is required to help them comply (vs. purely internal action).
- Uses the configured DingDuff connector directly for case-law and statutory citation verification; the monitor does not substitute CourtListener.

Full text: `mikeoss-fintech-gc-digest/assistant-workflows/gc-fintech-briefing-memo/SKILL.md`.

## 3. Step 2 — Set up two Mike projects (vaults)

1. **"Fintech Regulatory Intake"** — where every new feed item lands as a document before classification.
2. **"Internal Policy & Technical Control Library"** — upload current compliance policies, vendor-risk-management procedures, API security standards, and BSA/AML program documentation here. The memo workflow references documents from this vault for the gap-comparison step, same pattern as the insurance build.

## 4. Verified API contract (unchanged from insurance build)

| Action | Method & Path | Source |
|---|---|---|
| List/create projects | `GET/POST /projects` | `backend/src/routes/projects.ts` |
| Upload document to project | `POST /projects/:projectId/documents` (multipart, field `file`) | `backend/src/routes/projects.ts` |
| List/create workflows | `GET/POST /workflows` | `backend/src/routes/workflows.ts` |
| Create tabular review | `POST /tabular-review` | `backend/src/routes/tabular.ts` |
| Run tabular review | `POST /tabular-review/:reviewId/generate` | `backend/src/routes/tabular.ts` |
| Poll review status | `GET /tabular-review/:reviewId` | `backend/src/routes/tabular.ts` |
| Trigger assistant workflow (memo) | `POST /chat` with `messages[].workflow={id,title}` and `messages[].files=[{filename,document_id}]` | `backend/src/routes/chat.ts`, `backend/src/lib/chat/types.ts` |

## 5. Step 4 — Configure the native monitor

Open **Monitors** and select the **Fintech GC Regulatory Digest** preset. The preset installs the 33 feeds from `fintech_gc_digest_feeds.opml`, the classifier and briefing instructions described above, a daily schedule, a 14-day initial lookback, and a 50-item run limit. Select an analysis model or committee and optionally add DingDuff for case-law and statutory retrieval. The source pipeline deduplicates and checkpoints items in SQLite and escalates material developments into the saved report and configured email alert.

The bundled `run_gc_digest.py` and `mikeoss_client.py` are not used by the native monitor. Their tabular and chat API assumptions do not match the current streaming contracts.

A structural gap worth flagging directly to the GC: **card network rule changes (Visa, Mastercard, The Clearing House RTP) have no automatable public feed** — see the "Structural Gaps" section of `Fintech_GC_Digest_Regulatory_Feed_Sources.md`. Plan on either a paid regulatory-change-management subscription (e.g. Compliance.ai, Thomson Reuters Regulatory Intelligence) or a recurring manual PDF-diff review cadence for that category; don't assume the automated pipeline covers it.

## 6. Step 5 — Deployment checklist

- [ ] MikeOSS instance running with the selected local or cloud model configured.
- [ ] "Fintech Regulatory Intake" and "Internal Policy & Technical Control Library" projects created; policy library populated.
- [ ] Both fintech workflows created (via UI or `POST /workflows`) and their `id`s noted, or let `create_or_get_workflow` resolve them by title each run.
- [ ] Fintech GC preset saved from the Monitors page; source list and initial lookback reviewed.
- [ ] Optional DingDuff MCP connector selected with unattended read tools enabled.
- [ ] Tier 2 (GovDelivery/email) and Tier 3 (manual/API polling, including card-network rules) sources wired through approved feeds, watched public pages, or dedicated connectors.
- [ ] `RESEND_API_KEY` and the monitor's alert address configured when email delivery is required.
- [ ] Attorneys informed that generated legal analysis and citations require professional review before reliance.

## 7. Future extension

Same packaging path as the insurance version: once proven internally, these two workflows can be packaged as a `pack.yaml`-based add-on pack (per the `mike-workflows` pack convention) for other MikeOSS-based bank/credit-union technology vendors to install directly.

---

### Sources

- [Open-Legal-Products/mike (backend source)](https://github.com/Open-Legal-Products/mike)
- [backend/src/routes/workflows.ts](https://github.com/Open-Legal-Products/mike/blob/main/backend/src/routes/workflows.ts)
- [backend/src/routes/tabular.ts](https://github.com/Open-Legal-Products/mike/blob/main/backend/src/routes/tabular.ts)
- [backend/src/routes/projects.ts](https://github.com/Open-Legal-Products/mike/blob/main/backend/src/routes/projects.ts)
- [backend/src/routes/chat.ts](https://github.com/Open-Legal-Products/mike/blob/main/backend/src/routes/chat.ts)
- [backend/src/lib/chat/types.ts](https://github.com/Open-Legal-Products/mike/blob/main/backend/src/lib/chat/types.ts)
- [Open-Legal-Products/mike-workflows](https://github.com/Open-Legal-Products/mike-workflows)
- [mike-workflows workflow-schema/table-columns.schema.yaml](https://github.com/Open-Legal-Products/mike-workflows/blob/main/workflow-schema/table-columns.schema.yaml)
- [DingDuff](https://www.dingduff.com/)
- [DingDuff public wiki](https://github.com/DingDuff/dingduff-public/wiki)
