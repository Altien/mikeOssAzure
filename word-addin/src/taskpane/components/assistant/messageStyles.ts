/**
 * Visual constants duplicated from the web app's assistant panel
 * (frontend/src/app/components/assistant/message/messageStyles.ts) so the
 * task pane renders the same glass surfaces. Duplication is deliberate:
 * the add-in ships standalone, and a unified user experience matters more
 * than a shared import here.
 */
export const RESPONSE_GLASS_SURFACE =
  "rounded-xl border border-white/70 bg-white/55 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)] backdrop-blur-2xl";

/** Solid white card used for edit proposals (web EditCard / EditCardsSection). */
export const EDIT_CARD_SURFACE =
  "rounded-xl bg-white shadow-[0_3px_9px_rgba(15,23,42,0.1),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)] backdrop-blur-2xl";

export const EDIT_SECTION_SURFACE =
  "rounded-xl bg-white shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)] backdrop-blur-2xl";
