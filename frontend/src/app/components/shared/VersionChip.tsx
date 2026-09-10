/**
 * Small "V3" marker showing which version of a document is on screen.
 *
 * Deliberately unadorned — no border, no fill — so it sits quietly beside a
 * filename instead of competing with it, and reads the same on every surface
 * the app puts it on. Deciding *when* a version is worth showing stays with
 * the caller — a listing shows every version, the document tabs only bother
 * past V1 — while everything below the number is decided here.
 */
export function VersionChip({
    n,
    size = "md",
}: {
    n: number | null | undefined;
    /**
     * `sm` for dense rows such as the document tab strip, `lg` beside a
     * heading-sized filename. Scale it with the text it annotates: at `md`
     * next to an 18px title the number simply disappears.
     */
    size?: "sm" | "md" | "lg";
}) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return null;
    const scale = { sm: "text-[9px]", md: "text-[10px]", lg: "text-xs" }[size];
    return (
        <span
            className={`shrink-0 inline-flex items-center font-sans font-medium text-gray-500 ${scale}`}
        >
            V{n}
        </span>
    );
}
