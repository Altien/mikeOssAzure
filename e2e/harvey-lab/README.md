# Harvey LAB fixtures (firm-knowledge)

Realistic legal documents and directed test prompts for end-to-end testing
of Mike's assistant, document viewer and tabular review.

## Attribution

Taken from **Harvey LAB: The Legal Agent Benchmark**, © 2026 Harvey AI,
released under the MIT License (see [`LICENSE`](./LICENSE), copied unchanged).

- Upstream: https://github.com/harveyai/harvey-labs
- Copied from Altien's fork `Altien/harvey-labs-dev`, commit `d09ad59c43`
  (2026-09-26), path `tasks/firm-knowledge/`.
- Citation: Harvey AI, *Harvey LAB: The Legal Agent Benchmark*, v1.0, 2026.

The documents are synthetic (fictional firm, clients and matters).

**Before promoting to the public AGPL repo (MikeOSSAzure):** MIT is
AGPL-compatible provided this notice and `LICENSE` travel with the files.
Re-check the upstream licence at that time.

## Contents

| Path | What |
| --- | --- |
| `tasks/NNN.json` | All 250 firm-knowledge tasks: `instructions` (the prompt) and `criteria` (what a correct answer must identify). |
| `matters/<client>-<matter>/` | 11 matters (~8 MB), with `matter.json` and the matter's folders of `.docx`/`.xlsx`/`.eml`/`.pptx`. |

The full DMS is 266 matters / 524 MB, too big to commit. The included matters
are the answer matters for these single-matter tasks:

| Task | Matter | Title |
| --- | --- | --- |
| 008 | 1003-00001 | Most Recent Antitrust Matter Involving an HSR Filing |
| 023 | 1013-00001 | Most Recent Secured Banking & Finance Matter |
| 040 | 1020-00003 | Most Recent Withdrawn Offering |
| 066 | 1027-00002 | Most Recent Fund with an LP Advisory Committee |
| 073 | 1029-00001 | Most Recent Informed Consent and IRB Approval Matter |
| 081 | 1021-00004 | Most Recent Willful Infringement Case |
| 161 | 1008-00009 | Most Recent Data-Breach Matter |
| 185 | 1038-00003 | Most Recent Cascade Retail Holdings Matter |
| 226 | 1027-00004 | Most Recent Real Estate Deal with Title Insurance |
| 236 | 1003-00005 | Harrowgate PE Reorganization Tax Opinion Retrieval |
| 244 | 1032-00007 | Most Recent White Collar & Investigations Matter Involving a Litigation Hold |

The tasks are written as firm-wide searches ("find the most recent…"). With
only the answer matter loaded they become in-matter retrieval tests: does the
assistant find, cite and correctly read the documents that the `criteria`
name? For the full firm-wide version, copy more matters from the source:

```bash
cp -r ../harvey-labs-dev/tasks/firm-knowledge/dms/matters/<id> e2e/harvey-lab/matters/
```

(uncommitted, or add them to `.gitignore` locally).
