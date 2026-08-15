# @mike/icons

Canonical SVG icons for both front ends. **Edit the art here — nowhere else.**

Two consumers, two delivery mechanisms, because the apps are built by different
bundlers:

| App | How it consumes these files |
| --- | --- |
| `word-addin` | Imported directly. `webpack.config.js` aliases `@icons` to this directory, and the `asset/resource` rule emits each SVG with a content hash. |
| `frontend` | Copied into `frontend/public/icons/` by `frontend/scripts/sync-shared-icons.mjs`, because Next.js only serves static files that physically exist under `public/`. |

`frontend/public/icons/` is therefore **generated output** and is git-ignored.
The sync runs automatically from `predev`, `prebuild`, `predeploy`, `prepreview`
and `preupload` in `frontend/package.json`, so every npm entry point regenerates
it. If you ever run `next dev`/`next build` directly (bypassing npm scripts) on
a fresh clone, run the sync once by hand:

```sh
node frontend/scripts/sync-shared-icons.mjs
```

`--check` reports whether the copy is current without writing anything, which is
what CI should use if the generated directory is ever committed.

## Layout

Grouped by what an icon *depicts*, never by where it happens to be rendered —
the same art shows up in the sidebar, file rows, menus and modals, so a
by-location layout goes stale immediately.

| Folder | Contents |
| --- | --- |
| `features/` | Product surfaces: chat, chat history, history, library, quick actions, tabular review, workflow. |
| `file-types/` | One per document format: pdf, word, excel, ppt, chat. |
| `file-system/` | Containers and their open/closed states: folders and projects. |
| `legal-sources/` | Legal authorities: legislation and case law. |
| *(root)* | Everything else — upload sources (desktop, earth) and account actions (settings, sign out). |

`features/chat.svg` (the 64×64 skeuomorphic bubble, used by the sidebar and the
add-in menu) and `file-types/chat.svg` (a 24×24 mark for a saved chat) are
different art that share a name; the folders keep them apart.

## Adding an icon

1. Drop the SVG in the folder matching what it depicts.
2. Frontend: reference it by URL, e.g. `/icons/features/thing.svg` — the sync
   mirrors the folder structure into `public/`. Bump `ICON_VERSION` in
   `frontend/src/app/components/shared/AppSidebarSkeuoIcons.tsx` when changing
   existing art, since those URLs are cache-busted by query string.
3. Word add-in: `import thing from "@icons/features/thing.svg";`

The set is the union of what both apps need; not every icon is used by both.
