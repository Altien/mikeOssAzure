/**
 * Visual constants duplicated from the web assistant so the standalone Word
 * bundle uses the same glass surfaces without importing Next.js application
 * code.
 */
export const RESPONSE_GLASS_SURFACE =
  "rounded-xl border border-white/70 bg-white/55 shadow-sm backdrop-blur-2xl";

// No backdrop-blur here: these surfaces are fully opaque (bg-white), so the
// blur is invisible while still costing a compositing layer per card in the
// Office WebView.
export const EDIT_CARD_SURFACE =
  "rounded-xl bg-white shadow-sm";

export const EDIT_SECTION_SURFACE = RESPONSE_GLASS_SURFACE;
