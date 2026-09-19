# Shared PDF text-order cases

`cases.json` is the shared conformance suite for PDF reading-order
reconstruction. It is data, not code: it has no build step and nothing imports
it at runtime.

Two implementations must agree on the order they put PDF text items back into:

- `backend/src/lib/pdfTextOrder.ts` — orders items before `extractPdfText`
  rebuilds the page text the model reads and quotes from.
- `frontend/src/app/components/shared/views/pdfTextOrder.ts` — orders the
  rendered text layer's spans before the citation highlighter searches them.

A PDF content stream emits text in drawing order, not reading order, so both
sides reorder it. If they reorder it differently, a quote produced from the
backend's text cannot be found in the viewer's text layer and the citation
silently fails to highlight — visibly only on documents where drawing order
and reading order diverge, such as tables and multi-column layouts.

## What the ordering has to get right

Grouping items by baseline is not enough, because two layouts produce the same
baselines and want opposite reading orders:

- A **table row** reads across: `Name | Amount` on one line.
- A **two-column page** reads down each column. Joining the left column's line
  to the right column's line puts text from two unrelated sentences on one
  line, so a quote spanning two lines of a column is not contiguous in the
  extracted text and citation verification fails outright.

Both are told apart by scale, which is why each item carries a width. Prose
wraps to fill its measure, so a page gutter is narrow next to the blocks it
divides; a table's cells are short next to the space between them, and a
contents entry's leader gap dwarfs its page number. A gutter also has to be
wider than a justified line's word gaps, sit inside the text rather than
against a margin, and be respected by most of the region's rows — the few that
cross it are full-width elements (a title, a running header, a footnote) and
are emitted in place, so a heading cannot hide the columns beneath it.

A column is a block of text, not two rows that happen to leave a hole in the
same place, so detection needs several lines a side. Below that the pass falls
back to baseline grouping.

The two files are duplicated rather than shared because the backend builds
with plain `tsc` and no bundler (`rootDir: ./src`, `node dist/index.js`), and
`tsc` does not rewrite path aliases. `@mike/contracts` works across both apps
only because it is type-only and erased at compile time; a runtime import
would compile and then fail to resolve at run time.

`cases.json` is what keeps the copies honest. Both `pdfTextOrder.test.ts`
suites assert against it, so changing one implementation without the other
fails CI.

When changing the ordering heuristics:

1. Update both implementations together.
2. Add a case covering the layout that motivated the change.
3. Run `npm test --prefix backend -- src/lib/pdfTextOrder.test.ts` and
   `npm test --prefix frontend -- src/app/components/shared/views/pdfTextOrder.test.ts`.

## Case format

Each case supplies items in content-stream (drawing) order and the expected
grouping into lines, as indices into that input array. `x`/`y` are the item's
origin in PDF user space (y grows upward), `w` its advance width, and `h` its
glyph height:

```json
{
  "name": "two-column table drawn column by column",
  "items": [{ "x": 72, "y": 700, "w": 40, "h": 12 }],
  "expectedLines": [[0]]
}
```

`w` is load-bearing, not decoration: it is what separates a column gutter from
a wide word gap or a sparse table row. A case that omits it describes a page of
zero-width items and will not exercise column detection at all.
