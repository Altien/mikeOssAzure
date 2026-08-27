# Fintech / Digital Payments GC Digest — Regulatory & Trade Feed Sources

**Scope:** A bank/credit-union core-processing and digital-payments technology vendor "like Jack Henry & Associates" — core banking/processing, digital & mobile banking, remote deposit capture (RDC), ACH/wire/real-time payments (RTP/FedNow), card & payment network connectivity, fraud/AML transaction risk management (incl. AI/ML), and open banking/data-sharing APIs.

**Compiled:** July 29, 2026. All URLs below were live-tested (`curl -L`) and confirmed to return valid RSS/Atom XML, or — where no feed exists — the closest working email/manual-polling alternative is listed instead. Nothing here is a guessed URL pattern.

A vendor like Jack Henry sits in an unusual regulatory position: it is examined **indirectly** by the federal banking agencies under the Bank Service Company Act (BSCA) as a "bank service company"/critical third-party technology provider, is **directly** bound by payment-network operating rules (NACHA, FedNow/Fedwire, card networks), and is increasingly exposed to interagency AI/model-risk guidance that flows down through its bank and credit union customers' compliance obligations. The classifier tags below (see the MikeOSS workflow) are built around this three-way structure.

---

## Tier 1 — RSS/Atom (fully automatable, verified working)

### Federal banking regulators

| Source | Feed URL | Covers |
|---|---|---|
| OCC — News Releases | [occ.gov/rss/occ_news.xml](https://www.occ.gov/rss/occ_news.xml) | General news, enforcement actions |
| OCC — Bulletins | [occ.gov/rss/occ_bulletins.xml](https://www.occ.gov/rss/occ_bulletins.xml) | Supervisory guidance incl. third-party/vendor risk (e.g. Bulletin 2026-13 Model Risk Management) |
| FDIC — Financial Institution Letters | [public.govdelivery.com/topics/USFDIC_19/feed.rss](https://public.govdelivery.com/topics/USFDIC_19/feed.rss) | FILs — supervisory guidance for FDIC-supervised institutions and service providers |
| FDIC — Press Releases | [public.govdelivery.com/topics/USFDIC_26/feed.rss](https://public.govdelivery.com/topics/USFDIC_26/feed.rss) | Enforcement, rulemaking announcements |
| Federal Reserve — Banking/Consumer Reg Policy | [federalreserve.gov/feeds/press_bcreg.xml](https://www.federalreserve.gov/feeds/press_bcreg.xml) | Bank regulatory/supervisory press releases |
| Federal Reserve — SR & CA Letters/Manuals | [federalreserve.gov/feeds/bankinginfo-rss.xml](https://www.federalreserve.gov/feeds/bankinginfo-rss.xml) | Supervisory (SR) letters — e.g. SR 26-2 Model Risk Management, April 17, 2026 |
| Federal Reserve — All Press Releases | [federalreserve.gov/feeds/press_all.xml](https://www.federalreserve.gov/feeds/press_all.xml) | Full press release stream incl. FedNow announcements |
| CFPB — Newsroom | [consumerfinance.gov/about-us/newsroom/feed/](https://www.consumerfinance.gov/about-us/newsroom/feed/) | Enforcement, rulemaking, UDAAP actions |

### Federal Register (per-agency & term-search feeds — a structural finding: `documents.rss?conditions[agencies][]=<slug>` works; `documents/search.rss` returns bot-block pages)

| Source | Feed URL |
|---|---|
| OCC docket | [federalregister.gov/…agencies=comptroller-of-the-currency](https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=comptroller-of-the-currency) |
| FDIC docket | [federalregister.gov/…agencies=federal-deposit-insurance-corporation](https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=federal-deposit-insurance-corporation) |
| Federal Reserve System docket | [federalregister.gov/…agencies=federal-reserve-system](https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=federal-reserve-system) |
| CFPB docket | [federalregister.gov/…agencies=consumer-financial-protection-bureau](https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=consumer-financial-protection-bureau) |
| FinCEN docket | [federalregister.gov/…agencies=financial-crimes-enforcement-network](https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=financial-crimes-enforcement-network) |
| Treasury Department docket | [federalregister.gov/…agencies=treasury-department](https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=treasury-department) |
| NCUA docket | [federalregister.gov/…agencies=national-credit-union-administration](https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=national-credit-union-administration) |
| Term search: "bank service company" | [federalregister.gov/…term=bank+service+company](https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bterm%5D=bank+service+company) — cross-agency, catches BSCA-related rulemaking with low noise |
| Term search: "open banking" | [federalregister.gov/…term=open+banking](https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bterm%5D=open+banking) |

### State regulators

| Source | Feed URL | Covers |
|---|---|---|
| NY DFS — Press Releases | [dfs.ny.gov/…press_releases/rss.xml](https://www.dfs.ny.gov/reports_and_publications/press_releases/rss.xml) | Incl. 23 NYCRR 500 cybersecurity guidance (e.g. May 2026 frontier-AI cyber risk guidance) |
| California DFPI — News | [dfpi.ca.gov/feed/](https://dfpi.ca.gov/feed/) | Fintech/money-transmitter/lending regulator news |
| California DFPI — Press Releases | [dfpi.ca.gov/news/press-releases/feed/](https://dfpi.ca.gov/news/press-releases/feed/) | Enforcement, rulemaking |
| Texas Department of Banking | [dob.texas.gov/rss.xml](https://www.dob.texas.gov/rss.xml) | Press releases, Supervisory Update News Summary |

### Trade press

| Source | Feed URL |
|---|---|
| American Banker | [americanbanker.com/rss](https://www.americanbanker.com/rss) |
| Payments Dive (successor to PaymentsSource) | [paymentsdive.com/feeds/news/](https://www.paymentsdive.com/feeds/news/) |
| Finextra Headlines | [finextra.com/rss/headlines.aspx](https://www.finextra.com/rss/headlines.aspx) |
| Digital Transactions | [digitaltransactions.net/feed/](https://www.digitaltransactions.net/feed/) |
| PYMNTS.com | [pymnts.com/feed/](https://www.pymnts.com/feed/) |

### AI-in-financial-services trackers

| Source | Feed URL | Why it matters |
|---|---|---|
| Consumer Finance Monitor — AI tag (Ballard Spahr) | [consumerfinancemonitor.com/artificial-intelligence/feed/](https://www.consumerfinancemonitor.com/artificial-intelligence/feed/) | Dedicated filtered feed on AI regulation in consumer financial services |
| Consumer Finance Monitor — full feed | [consumerfinancemonitor.com/feed/](https://www.consumerfinancemonitor.com/feed/) | Broader CFPB/FDIC/OCC consumer-finance coverage |
| Consumer Financial Services Law Monitor (Troutman Pepper) | [consumerfinancialserviceslawmonitor.com/feed/](https://www.consumerfinancialserviceslawmonitor.com/feed/) | CFPB's AI/algorithmic-model stance, fair-lending testing standards |

### Cybersecurity

| Source | Feed URL |
|---|---|
| CISA — All Cybersecurity Advisories | [cisa.gov/cybersecurity-advisories/all.xml](https://www.cisa.gov/cybersecurity-advisories/all.xml) |
| CISA — News | [cisa.gov/news.xml](https://www.cisa.gov/news.xml) |
| CISA — Alerts (legacy US-CERT path, still live) | [cisa.gov/uscert/ncas/alerts.xml](https://www.cisa.gov/uscert/ncas/alerts.xml) |
| CIS/MS-ISAC — Advisories (proxy where FS-ISAC is gated) | [cisecurity.org/feed/advisories](https://www.cisecurity.org/feed/advisories) |

**33 Tier 1 feeds total, bundled in the attached OPML file for one-click import into any RSS reader or agent ingestion pipeline.**

---

## Tier 2 — Email/GovDelivery subscriptions (route to a monitored inbox, then parse/forward into the pipeline)

| Source | Subscribe URL | Covers |
|---|---|---|
| NCUA Subscriber Preferences | [subscriptions.ncua.gov/ncua-subscriber-preferences](https://subscriptions.ncua.gov/ncua-subscriber-preferences) | Letters to Credit Unions, exam guidance (no RSS exists) |
| FFIEC GovDelivery | [public.govdelivery.com/accounts/USFIND/subscriber/new](https://public.govdelivery.com/accounts/USFIND/subscriber/new) | IT Examination Handbook updates, joint guidance |
| FinCEN Updates GovDelivery | [service.govdelivery.com/accounts/USFINCEN/subscriber/new](https://service.govdelivery.com/accounts/USFINCEN/subscriber/new) | BSA/AML advisories — critical for AML/transaction-monitoring features |
| OFAC Recent Actions email | [service.govdelivery.com/service/subscribe.html?code=USTREAS_61](https://service.govdelivery.com/service/subscribe.html?code=USTREAS_61) | Sanctions list updates (RSS officially retired Jan 31, 2025) |
| NACHA Rules News sign-up | [nacha.org/content/sign-rules-news-and-risk-management-tools](https://www.nacha.org/content/sign-rules-news-and-risk-management-tools) | ACH Operating Rules updates — directly governs Jack Henry's ACH processing |
| Treasury GovDelivery | [public.govdelivery.com/accounts/USTREAS/subscriber/new](https://public.govdelivery.com/accounts/USTREAS/subscriber/new) | Treasury press releases, AI/fintech policy |
| FedNow News newsletter | [explore.fednow.org/register](https://explore.fednow.org/register) | Instant-payments feature/rule announcements |
| IDFPR Newsroom sign-up | [idfpr.illinois.gov/news/newsroom.html](https://idfpr.illinois.gov/news/newsroom.html) | Illinois banking/credit-union/money-transmitter oversight |
| CISA GovDelivery (incl. Known Exploited Vulnerabilities) | [public.govdelivery.com/accounts/USDHSCISA/subscriber/new](https://public.govdelivery.com/accounts/USDHSCISA/subscriber/new) | Complementary to RSS per CISA's May 2025 channel-priority change |

---

## Tier 3 — Manual/API polling (no automatable feed found; card network rules are a genuine structural gap)

| Source | Access point | Note |
|---|---|---|
| CFPB Section 1033 (Open Banking) rulemaking tracker | [consumerfinance.gov/…personal-financial-data-rights-reconsideration/](https://www.consumerfinance.gov/rules-policy/rules-under-development/personal-financial-data-rights-reconsideration/) | Finalized Oct 2024, enjoined by E.D. Kentucky, CFPB issued ANPR Aug 2025; status unsettled as of mid-2026 — directly governs Jack Henry's open banking API obligations |
| CFPB Final Rules page (Section 1071) | [consumerfinance.gov/rules-policy/final-rules/](https://www.consumerfinance.gov/rules-policy/final-rules/) | Small-business lending data rule |
| Visa Business News / Rules | [usa.visa.com/…visa-rules-public.pdf](https://usa.visa.com/dam/VCOM/download/about-visa/visa-rules-public.pdf) | No public RSS; distributed as periodic PDF bulletins via partner portal |
| Mastercard Rules & Compliance Programs | [mastercard.com/us/en/business/support/rules.html](https://www.mastercard.com/us/en/business/support/rules.html) | No public RSS; PDF rule manual, periodic revisions |
| The Clearing House — RTP Document Library | [theclearinghouse.org/payment-systems/rtp/document-library](https://www.theclearinghouse.org/payment-systems/rtp/document-library) | No RSS/email blast; publishes dated Current/Upcoming rule sets |
| NACHA News / New Rules calendar | [nacha.org/news](https://www.nacha.org/news) / [nacha.org/newrules](https://www.nacha.org/newrules) | Effective-date tracker for ACH rule changes |
| FRB Services / FedNow press releases | [frbservices.org/news/press-releases](https://www.frbservices.org/news/press-releases) | Operational FedNow announcements (certifications, transaction limits, ISO 20022 migration) |
| CSBS Press Releases | [csbs.org/press-room/press-releases](https://www.csbs.org/press-room/press-releases) | State regulator umbrella group; money-transmitter licensing coordination |
| IAPP US State Privacy Legislation Tracker | [iapp.org/resources/article/us-state-privacy-legislation-tracker](https://iapp.org/resources/article/us-state-privacy-legislation-tracker) | Industry-standard aggregator for 20+ state consumer privacy laws; no feed, manually diff by "last updated" date |
| CFPB Advanced Technology / AI page | [consumerfinance.gov/ai/](https://www.consumerfinance.gov/ai/) | Primary-source federal AI/algorithmic-model oversight guidance |
| Credit Union Times / CU Today | [cutimes.com](https://www.cutimes.com) / [cutoday.info](https://www.cutoday.info) | Cloudflare-blocked / robots.txt disallows RSS — relevant since Jack Henry serves credit unions |
| The Financial Brand | [thefinancialbrand.com/news](https://thefinancialbrand.com/news) | Site rebuilt without public feed |
| FS-ISAC | [fsisac.com](https://www.fsisac.com/) | Finance-specific ISAC; membership-gated, no public feed |

---

## Key Regulatory Context (as of July 29, 2026)

- **Interagency Model Risk Management overhaul (Apr 17, 2026):** The Fed (SR 26-2), OCC (Bulletin 2026-13), and FDIC jointly superseded the 15-year-old SR 11-7/OCC 2011-12 framework, explicitly addressing AI/ML models in credit underwriting, fraud detection, and AML, while flagging generative/agentic AI as "novel and rapidly evolving" pending further guidance — the single most consequential recent development for an AI-driven fraud/AML vendor, automatically captured by the OCC Bulletins and Fed SR Letters Tier-1 feeds ([Federal Reserve SR 26-2](https://www.federalreserve.gov/supervisionreg/srletters/SR2602.htm)).
- **Section 1033 Open Banking status:** Finalized Oct 2024, enjoined in E.D. Kentucky, CFPB ANPR issued Aug 2025 (comment period closed Oct 21, 2025) to reconsider the rule; unsettled as of mid-2026 — must be tracked manually since no dedicated docket feed exists ([CFPB tracker](https://www.consumerfinance.gov/rules-policy/rules-under-development/personal-financial-data-rights-reconsideration/)).
- **OFAC retired its RSS feed** on January 31, 2025, moving exclusively to GovDelivery email ([OFAC notice](https://ofac.treasury.gov/recent-actions/20241122)).
- **Treasury's Financial Services AI Risk Management Framework (FS AI RMF):** Released Feb 2026, adapting the NIST AI RMF specifically for financial institutions and their technology providers ([Treasury press release](https://home.treasury.gov/news/press-releases/sb0401)).
- **FedNow continues expanding**: transaction limit raised to $10M in 2025; intermediary/correspondent-bank proposal opened for comment April 2026 ([Fed press release, Apr 8, 2026](https://www.federalreserve.gov/newsevents/pressreleases/other20260408a.htm)).
- **CISA changed its posting model in May 2025** — routine advisories now go out primarily via email/RSS/X rather than the advisories webpage, making the RSS feeds the authoritative real-time channel ([CISA update](https://www.cisa.gov/news-events/alerts/2025/05/12/update-how-cisa-shares-cyber-related-alerts-and-notifications)).

## Structural Gaps Worth Flagging to the GC

Card network rule changes (Visa, Mastercard, The Clearing House RTP) have **no automatable public feed at all** — this is a genuine gap that most compliance teams close with a paid regulatory-change-management tool (e.g. Compliance.ai, Thomson Reuters Regulatory Intelligence) or a recurring manual PDF-diff cadence, not with a free RSS source. The same is true for FS-ISAC (membership-gated) and the IAPP state privacy tracker (no feed). These should be flagged in the build guide as "requires a paid source or manual review," not silently omitted from the monitoring set.

---

*Research conducted July 29, 2026 by two parallel research passes — federal banking/payments regulators and fintech trade press/state/card-network/cybersecurity sources — with every Tier 1 URL live-verified via direct HTTP fetch confirming valid RSS/Atom XML content, not inferred from naming conventions.*
