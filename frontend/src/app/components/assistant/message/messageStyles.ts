import { GLASS_CARD_SURFACE_CLASS } from "@/app/components/ui/glass-card";

export const RESPONSE_GLASS_SURFACE = GLASS_CARD_SURFACE_CLASS;
export const RESPONSE_GLASS_ANNOTATION =
    "inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-200/60 bg-gray-200/80 text-[12px] font-serif font-medium text-gray-800 shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(243,244,246,0.85),inset_0_-2px_4px_rgba(229,231,235,0.65)] backdrop-blur-xl transition-colors hover:bg-gray-200 hover:text-gray-950";

export function withoutMarkdownNode<P extends { node?: unknown }>(
    props: P,
): Omit<P, "node"> {
    const { node, ...rest } = props;
    void node;
    return rest;
}
