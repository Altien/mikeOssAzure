import { GLASS_CARD_SURFACE_CLASS } from "@mike/glass-card-ui";

export const RESPONSE_GLASS_SURFACE = GLASS_CARD_SURFACE_CLASS;

// No backdrop-blur here: these surfaces are fully opaque (bg-white), so the
// blur is invisible while still costing a compositing layer per card in the
// Office WebView.
export const EDIT_CARD_SURFACE =
  "rounded-xl bg-white shadow-sm";

export const EDIT_SECTION_SURFACE = RESPONSE_GLASS_SURFACE;
