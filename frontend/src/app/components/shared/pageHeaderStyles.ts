// Kept apart from PageHeader.tsx so a page can take the title's style
// without depending on the header component itself.

/**
 * The display style of a page's title, shared by a plain title (an `<h1>`
 * passed as the header's children) and the breadcrumbs, so the two are the
 * same size on every page. One step below the display headings used for
 * empty states: a page title sits beside the header's controls, and at their
 * size it crowded them.
 */
export const PAGE_HEADER_TITLE_CLASS = "font-serif text-xl font-medium";
