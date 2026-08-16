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
            className="inline-flex h-4 w-4 shrink-0 self-center items-center justify-center rounded-full bg-gray-200 text-[9px] font-medium leading-none text-gray-600"
        >
            {number}
        </span>
    );
}
