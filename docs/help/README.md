# Help guides

Markdown files in this directory are served to signed-in users at `/help`, with
a contents list down the side. Anything else under `docs/` is contributor and
operator material: it is not copied into the image and not exposed by the API.

This directory is meant to be extended. A firm running its own deployment can
add guides covering how *it* works, alongside the ones shipped with the
product — house citation style, matter-opening procedure, which practice
groups may use which features, who to contact when something looks wrong. To
the reader they sit in one contents list, with no distinction between what came
from the product and what came from the firm.

## Adding a guide

1. Create `<slug>.md` in this directory. The slug must match
   `^[a-z][a-z0-9-]*$` and becomes the URL fragment, so `house-style.md` is
   reachable at `/help#house-style`.
2. Begin the file with a single `# Heading`. That heading is the title in the
   contents list; without one, the slug is shown instead.
3. Rebuild and redeploy the image. Guides are baked in at build time, so a new
   file reaches users on the next deployment.

Guides are listed alphabetically by title. There is no nesting and no ordering
control: if you want a reading order, say so in the titles.

## Writing them

These are read by people doing legal work, usually at the moment something has
confused them. What helps:

- **Say what a thing does not do.** A feature's limits are what a professional
  needs to know before relying on it, and are the hardest thing to infer from
  the interface.
- **Name what the reader sees.** Use the exact labels and messages that appear
  on screen, so someone can match the guide to the thing in front of them.
- **Cover the awkward cases.** Scanned documents, tracked changes, a result
  that looks wrong but isn't. This is what people actually arrive with.
- **Say who to ask.** A firm-written guide is the right place to name the
  supervising partner, the knowledge team, or the IT contact for a question the
  product cannot answer.

Avoid restating the interface. A guide that lists which buttons exist ages
badly and helps nobody; a guide explaining what a result means keeps its value.

## Constraints

- GitHub-flavoured markdown, including tables.
- Images are not served from this directory.
- Guides are visible to every signed-in user of the deployment. Nothing here is
  access-controlled, so do not put client-confidential material or anything
  matter-specific in a guide.
- This README is not listed as a guide.
