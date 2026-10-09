/**
 * Reading-order reconstruction for positioned PDF text items.
 *
 * A PDF content stream emits text in drawing order, which is not reading
 * order: generators routinely draw a whole column before the column beside it.
 * Both the backend extractor and the web viewer's citation highlighter have to
 * put items back in the same order, or a quote the model produces from the
 * extracted text cannot be found in the rendered text layer.
 *
 * Grouping by baseline alone is not enough. On a multi-column page the left
 * column's line and the right column's line share a baseline band, so a
 * baseline-only pass glues them into one line and the extracted text reads
 * across the gutter. Any quote spanning two lines of one column is then
 * non-contiguous in the source and fails verification outright. So this module
 * cuts a page into columns first (an XY-cut), and groups baselines within each
 * column.
 *
 * MIRRORED FILE — keep in sync with
 * `frontend/src/app/components/shared/views/pdfTextOrder.ts`.
 *
 * The backend compiles with plain `tsc` (no bundler, `rootDir: ./src`), and
 * `tsc` does not rewrite path aliases, so a shared runtime package cannot be
 * imported from both apps without changing how the backend builds and ships.
 * The two copies are instead pinned together by the shared cases in
 * `packages/pdf-text-order/cases.json`, which both test suites assert against:
 * changing one implementation without the other fails CI.
 */

/**
 * The geometry an item needs to be placed. `x`/`y` are the item's origin in
 * PDF user space, where y grows upward; `w` is its advance width and `h` its
 * glyph height.
 *
 * `w` is what separates a column gutter from a wide word gap or a sparse table
 * row, so both callers must pass the width pdfjs reports rather than
 * defaulting it to zero.
 *
 * These are the raw content-stream coordinates, which ignore the page's
 * `/Rotate` entry. That is wrong for rotated pages, but it is wrong
 * identically on both sides, so highlighting still matches. Fixing rotation
 * means mapping through `page.getViewport()` in both copies at once.
 */
export type TextItemGeometry = {
  x: number;
  y: number;
  w: number;
  h: number;
};

/** A horizontal span in PDF user-space units. */
type Span = { start: number; end: number };

// A gutter has to be wider than ordinary inter-word space. Justified prose
// routinely opens 3-4pt word gaps and those must never read as a column
// boundary, so a candidate must clear both an absolute floor and a multiple of
// the local type size.
const MIN_GUTTER_PT = 12;
const MIN_GUTTER_EM = 1.2;

// A column boundary is a property of a text block, not of two stray rows that
// happen to leave a hole in the same place.
const MIN_ROWS_TO_SPLIT = 4;
const MIN_ROWS_PER_COLUMN = 3;

// Share of a region's rows allowed to cross a gutter and still leave it a
// gutter. Those rows are full-width elements — a title, a running header, a
// footnote — and are emitted in place rather than disqualifying it.
const MAX_GUTTER_CROSSING_SHARE = 0.2;

// Splitting strictly shrinks the row set, so recursion terminates on its own.
// The cap only bounds the cost of a pathological page; hitting it falls back to
// baseline grouping, which is the behavior from before columns existed.
const MAX_SPLIT_DEPTH = 4;

/**
 * Group items into visual lines and order them for reading: columns left to
 * right, and each column's rows top to bottom.
 *
 * Returns one array of indices into `items` per line, rather than the items
 * themselves, so callers can carry their own per-item payload alongside.
 */
export function orderTextItemLines(
  items: readonly TextItemGeometry[],
): number[][] {
  if (!items.length) return [];
  const all = items.map((_, index) => index);
  return orderRegion(items, groupIntoRows(items, all), 0);
}

/**
 * Cluster a set of items into baseline rows, top to bottom, each row ordered
 * left to right.
 *
 * A row here is only a band of shared baseline: on a multi-column page it can
 * still hold text from several columns, which is what `orderRegion` unpicks.
 */
function groupIntoRows(
  items: readonly TextItemGeometry[],
  indices: readonly number[],
): number[][] {
  const byBaseline = indices.slice();
  byBaseline.sort((a, b) => items[b].y - items[a].y || items[a].x - items[b].x);

  const rows: number[][] = [];
  let current: number[] = [];
  let currentY: number | null = null;
  let currentH = 0;
  for (const index of byBaseline) {
    const item = items[index];
    if (
      currentY === null ||
      Math.abs(item.y - currentY) > Math.max(2, currentH * 0.5)
    ) {
      current = [];
      rows.push(current);
      // Keep a fixed anchor so small baseline differences cannot chain
      // together and accidentally merge successive rows.
      currentY = item.y;
      currentH = item.h;
    }
    current.push(index);
  }

  // Rows are already top-to-bottom (PDF y grows upward).
  for (const row of rows) row.sort((a, b) => items[a].x - items[b].x);
  return rows;
}

/**
 * Order a region's rows, cutting it into columns where a gutter runs through
 * it. Rows that cross the gutter bound the columnar bands above and below them
 * and are emitted in place, so a full-width title keeps its position rather
 * than blocking column detection for the body beneath it.
 */
function orderRegion(
  items: readonly TextItemGeometry[],
  rows: readonly number[][],
  depth: number,
): number[][] {
  if (depth >= MAX_SPLIT_DEPTH || rows.length < MIN_ROWS_TO_SPLIT) {
    return rows.slice();
  }
  const gutter = findColumnGutter(items, rows);
  if (!gutter) return rows.slice();

  const ordered: number[][] = [];
  let band: number[][] = [];

  const flushBand = () => {
    if (!band.length) return;
    // Regroup each side into its own rows: the whole point is that a band row
    // holding both columns' text must come apart, not stay glued together.
    const left: number[] = [];
    const right: number[] = [];
    for (const row of band) {
      for (const index of row) {
        (items[index].x < gutter.start ? left : right).push(index);
      }
    }
    for (const side of [left, right]) {
      if (!side.length) continue;
      ordered.push(
        ...orderRegion(items, groupIntoRows(items, side), depth + 1),
      );
    }
    band = [];
  };

  for (const row of rows) {
    if (crossesGutter(items, row, gutter)) {
      flushBand();
      ordered.push(row);
    } else {
      band.push(row);
    }
  }
  flushBand();
  return ordered;
}

/** Whether any of a row's items overlaps the gutter span. */
function crossesGutter(
  items: readonly TextItemGeometry[],
  row: readonly number[],
  gutter: Span,
): boolean {
  return row.some((index) => {
    const item = items[index];
    return item.x < gutter.end && item.x + itemWidth(item) > gutter.start;
  });
}

function itemWidth(item: TextItemGeometry): number {
  return Number.isFinite(item.w) ? Math.max(0, item.w) : 0;
}

/**
 * Find the widest interior vertical strip that nearly every row leaves blank,
 * or null when the region has no column structure.
 */
function findColumnGutter(
  items: readonly TextItemGeometry[],
  rows: readonly number[][],
): Span | null {
  let minX = Infinity;
  let maxX = -Infinity;
  const heights: number[] = [];
  for (const row of rows) {
    for (const index of row) {
      const item = items[index];
      minX = Math.min(minX, item.x);
      maxX = Math.max(maxX, item.x + itemWidth(item));
      heights.push(item.h);
    }
  }
  if (!(maxX > minX)) return null;

  // Coverage profile over the region's width, roughly one bin per point. Bins
  // rather than interval arithmetic because a gutter is a strip that rows
  // agree on only approximately, and binning is what makes "the same strip"
  // tolerant of a point of ragged alignment.
  const span = maxX - minX;
  const bins = Math.min(2048, Math.max(1, Math.ceil(span)));
  const perPoint = bins / span;
  const rowsCovering = new Array<number>(bins).fill(0);
  for (const row of rows) {
    const touched = new Set<number>();
    for (const index of row) {
      const item = items[index];
      const from = Math.max(0, Math.floor((item.x - minX) * perPoint));
      const to = Math.min(
        bins - 1,
        Math.ceil((item.x + itemWidth(item) - minX) * perPoint),
      );
      for (let bin = from; bin <= to; bin++) touched.add(bin);
    }
    for (const bin of touched) rowsCovering[bin] += 1;
  }

  const minWidth = Math.max(MIN_GUTTER_PT, median(heights) * MIN_GUTTER_EM);
  // Floored to whole rows: the comparison counts rows, and deriving the bound
  // in floating point puts an allowance of "one row" just under 1.
  const maxCrossing = Math.floor(
    rows.length * MAX_GUTTER_CROSSING_SHARE + 1e-9,
  );

  let best: Span | null = null;
  let runStart: number | null = null;
  for (let bin = 0; bin <= bins; bin++) {
    if (bin < bins && rowsCovering[bin] <= maxCrossing) {
      if (runStart === null) runStart = bin;
      continue;
    }
    if (runStart !== null) {
      // A blank run touching a region edge is a margin, not a gutter.
      if (runStart > 0 && bin < bins) {
        const candidate = {
          start: minX + runStart / perPoint,
          end: minX + bin / perPoint,
        };
        if (
          candidate.end - candidate.start >= minWidth &&
          (!best || candidate.end - candidate.start > best.end - best.start)
        ) {
          best = candidate;
        }
      }
      runStart = null;
    }
  }

  return best && isColumnGutter(items, rows, best) ? best : null;
}

/**
 * Distinguish a page gutter from the whitespace inside columnar data.
 *
 * Both a two-column article and a two-column table leave an unbroken vertical
 * strip down the page, but they want opposite reading orders: the article
 * reads down each column, the table across each row. The separator is scale.
 * Prose wraps to fill its measure, so the gutter is narrow next to the text
 * blocks it divides; a table's cells are short next to the space between them,
 * and a table of contents' leader gap dwarfs its page numbers.
 */
function isColumnGutter(
  items: readonly TextItemGeometry[],
  rows: readonly number[][],
  gutter: Span,
): boolean {
  let leftRows = 0;
  let rightRows = 0;
  let leftMin = Infinity;
  let leftMax = -Infinity;
  let rightMin = Infinity;
  let rightMax = -Infinity;
  for (const row of rows) {
    let hasLeft = false;
    let hasRight = false;
    for (const index of row) {
      const item = items[index];
      const end = item.x + itemWidth(item);
      if (item.x < gutter.start) {
        hasLeft = true;
        leftMin = Math.min(leftMin, item.x);
        leftMax = Math.max(leftMax, end);
      } else {
        hasRight = true;
        rightMin = Math.min(rightMin, item.x);
        rightMax = Math.max(rightMax, end);
      }
    }
    if (hasLeft) leftRows += 1;
    if (hasRight) rightRows += 1;
  }
  if (leftRows < MIN_ROWS_PER_COLUMN || rightRows < MIN_ROWS_PER_COLUMN) {
    return false;
  }
  const narrowerBlock = Math.min(leftMax - leftMin, rightMax - rightMin);
  return gutter.end - gutter.start < narrowerBlock;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
