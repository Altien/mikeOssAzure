export function ContextNumberBadge({
    number,
    label,
}: {
    number: number | undefined;
    label: string;
}) {
    if (number === undefined) return null;

    return (
        <span
            aria-label={`${label} ${number}`}
            title={`${label} ${number}`}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[10px] font-medium text-gray-600"
        >
            {number}
        </span>
    );
}
