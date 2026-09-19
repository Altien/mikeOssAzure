// No backdrop-blur on these surfaces: they are fully opaque, so the blur is
// invisible while still costing a compositing layer per card in the Office
// WebView.
export const RESPONSE_GLASS_SURFACE = "rounded-xl liquid-glass-flat";

export const EDIT_CARD_SURFACE = "rounded-xl bg-white shadow-sm";

export const EDIT_SECTION_SURFACE = RESPONSE_GLASS_SURFACE;
