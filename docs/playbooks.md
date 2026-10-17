# Playbooks

Mike playbooks convert a human-authored Word negotiation guide into
structured rules that can review contracts.

## Data model

A playbook contains global guidance and rules, optionally organized into
topics. Each rule contains:

- a concept to identify at clause or agreement scope;
- a required/optional setting;
- standard, fallback, and unacceptable positions;
- illustrative, preferred, verbatim, accepted, or unacceptable sample clauses;
- conditions, reviewer guidance, and escalation actions; and
- source references to the imported Word paragraph or table cell.

A playbook starts in one of two ways: compiled from a Word negotiation guide,
or written by hand in the editor. A hand-authored rule carries no source
references; the strict source check below applies to compiled imports only.

Changes save automatically. Reviews use the latest saved rules and retain a
content snapshot so later edits do not change an in-progress or historical
review. There is no publishing step or numbered playbook version.

## Browsing and editing

The Playbooks table shows each playbook on one line, with its access, creator,
document types, represented party, jurisdictions, rule count, and last update.
Use the header search to find a playbook by name
or description. Checkboxes select rows for bulk deletion; select a name to
open the editor.

The default **All** tab shows every playbook available in the current workspace.
Personal workspaces also have **My playbooks** and **Shared with me** tabs.
Organization workspaces also have **Private** and **Public** tabs.

### Access

Access works as it does for workflows. Open the people button (beside the
**⋯** menu in the header) to see who can open a playbook and, as an owner, to
change it. Each person has a role:

- **Viewer**: view the rules and sources and run reviews.
- **Editor**: also edit rules, details, and supplementary documents, and
  replace the playbook from Word.
- **Owner**: also share it, change its visibility, and delete it. The creator
  is always an owner.

A personal playbook is shared with existing accounts by email; recipients find
it under **Shared with me**. An organization's playbook is shared only with
its members. A **Public** one (set in **Overview**) can be viewed and run by
every member; unlike a workflow, members do not get Editor by default, so
editing is granted person by person, and members can be put on a deny list.
The organization's owners own every public playbook. A **Private** one is
open only to the people it is shared with. Sharing sends no email
notification. Unlike projects and workflows, an organization's owners do not
take over a private playbook whose creator has left.

The editor has two flat glass panels: rules on the left, and the selected
rule's form on the right. The rules sidebar uses the IDE Explorer's compact
rows, with a small dot before each rule name. Opening a playbook selects its first rule.
The sidebar's **+** adds an ungrouped rule. To organize rules, choose
**Add topic** from **Rules actions**, then use the rule form's **Topic** field
to move a rule into that topic or back to **No topic**. Existing imported
topics remain available.
Drag a rule above or below another rule to reorder it, onto a topic to group
it, or onto the sidebar's header or empty space to ungroup it. Right-click a
rule for edit, duplicate, move, and delete actions. Every rule row and the rule
form have a **…** menu with those same actions. Each topic row also has a **…**
menu, including **Add rule** to create a rule in that topic.
Duplicating places an independent copy immediately
after the source rule in the same topic (or in the ungrouped list) and selects
it for editing. Right-click the sidebar to add a rule
or topic, or a topic to remove the group while keeping its rules. The same
menus open with Shift+F10 or the keyboard's context-menu key. Changes autosave.
Select a rule to edit its concept, scope, positions, and sample clauses. Drag
the divider to adjust the panel widths, or focus it and use the arrow keys.
The panels stack on narrow screens. A toolbar above them contains **Overview**,
**Rules**, **References**, and **Runs**, with a **New rule** button on the right
of the Rules view that adds and selects an ungrouped rule.
**Run** is in the page header. Use **Overview** to edit the
playbook name, represented party, description, and global guidance, alongside
source metadata, dates, and, in an organization, Private or Public. These fields also save automatically.

The header shows **Saving…**, **Saved**, or **Couldn’t save** in its own button
group. **Saved** disappears after two seconds, as in the workflow editor. Autosave accepts
unfinished fields; running a review requires complete rules. Pending changes
are saved before returning to the table, replacing from Word, or starting a
review. A failed save retains the current edits and offers a retry.

## Starting a playbook without a Word file

Open **Playbooks**, select **New playbook**, then **Start from scratch**. Mike
opens the new playbook on **Overview**, where its name and scope can be set
before moving to **Rules**. It starts with one ungrouped rule and no topics. A rule always
needs a concept, so the first one carries placeholder text to replace.

## Importing a Word playbook

1. Open **Playbooks**, select **New playbook**, then **Import Word playbook**.
2. Select a `.docx` playbook and a compilation model. Only models with usable
   credentials are offered, and Mike preselects an available one.
3. Review the extracted topics, concepts, positions, sample clauses, and
   source references.
4. Refine the rules as needed; corrections save automatically.

The browser uploads the `.docx` straight to object storage under a presigned
URL scoped to the signed-in account, then asks the API to compile it from that
key. The API never receives the file body, and the staged object is removed
once the import finishes, successfully or not.

The importer reads Word headings, paragraphs, and tables before asking the
model to compile the material. Mike automatically recompiles once when the
first response is not valid JSON, fails schema validation, or cannot be tied
back to the Word source. It retains the original `.docx` only after
compilation succeeds. Every imported rule must resolve to at least one real
source reference, or the import fails rather than creating an unauditable
rule. The parsed Word structure is transient; only the original file and the
compiled content with source references are retained, avoiding a duplicate
document copy in the database.

Each model attempt has five minutes by default. Set
`PLAYBOOK_COMPILATION_TIMEOUT_MS` to override that limit, or
`LLM_REQUEST_TIMEOUT_MS` to set a shared default. A playbook-specific value
takes precedence. The limit bounds how long an import waits; it does not abort
the model request already in flight.

Each import creates an audit record with its current processing stage. Failed
imports retain the stage and error without retaining the source document,
making credential, Word extraction, model compilation, and output-validation
failures distinguishable.

## Replacing a playbook from a newer Word file

Open the playbook's actions menu, then **Replace from Word**. The compiled
result rewrites that playbook's content and keeps its name unless you supply a
new one.

A replacement rewrites the current rules. Completed and in-progress reviews
retain the rules they started with. The replaced `.docx` is removed once the
new content is stored, and the same rate limit and ownership checks apply as
for a first import.

## References

The **References** tab, beside **Rules** in the playbook toolbar, lists the
documents behind a playbook in one list and shows the selected one read-only
on the right. The list starts with the Word file the playbook was compiled
from, if any, followed by up to 20 supplementary `.docx` or `.pdf` documents
the rules can refer to, such as a data protection policy or a clause template.
An editor adds supplementary documents with **+** or **Upload** (upload a
file, or choose one from the library or a project) and removes them from each
document's menu; the imported Word file changes only through **Replace from
Word**.

A supplementary document is a copy the playbook owns: anyone who can view the
playbook can open it, and later edits to the original do not change it. Its
text is extracted when it is added. Files are stored under
`playbooks/<creator>/<playbook>/sources/`. Database triggers queue durable file
cleanup on replacement or deletion, including account and organization
cascades; failed storage deletions are retried by the job worker.

Reviews do not receive supplementary text by default. When a playbook has
supplementary documents, the review prompt lists their ids, names, and
lengths, and the model calls `read_supplementary_document` to read the ones a
rule, guidance, or instruction depends on, in pieces of up to 40,000
characters. The tool only reads documents belonging to the playbook under
review. A playbook without supplementary documents is reviewed in a single
model call, as before.

## Model selection

The compilation and review model menus draw on the same catalog as chat:
built-in cloud models, discovered Ollama models, and OpenRouter models when an
OpenRouter key is configured. A model is offered only when the account has a
usable key for its provider; organization playbooks use that workspace’s
effective provider keys. Local Ollama models need none.

## Contract review

Select **Run**, choose strict or permissive posture, and use
**Add document** in the modal footer to upload a PDF, DOCX, or TXT contract or
choose saved files. Multiple files can be dropped into the document area;
each file gets its own review run. Strict mode flags fallback
matches for review; permissive mode may accept them but still explains the
applied fallback.

Review findings include the rule, status, exact contract quote,
location, analysis, and suggested language. Each run is retained with the
exact content it was reviewed against.

Word reviews read the stored file and save suggestions as tracked changes when
the caller can edit it. If that file changes while the model is reviewing it,
the suggestions remain as text; rerun the review against the new version
before applying them.

A playbook's **Runs** tab lists your last 50 runs of it, newest first;
selecting one shows its settings, summary, and findings grouped by outcome,
with recommended language as a redline of the contract text. A run opens there
when it finishes. The **Runs** tab on the playbooks list shows your last 100
runs across every playbook you can still open in the workspace (`GET
/playbooks/runs`); choosing one opens it on its playbook. Each person sees only
their own runs, including on a shared playbook, and the rules snapshot stored
with a run is never returned by either list.

The current one-pass safety limits are 150,000 extracted characters per
imported playbook, 100,000 serialized characters per playbook, and
180,000 characters per reviewed contract. Oversized inputs fail explicitly
instead of being silently truncated.
