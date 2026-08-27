"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BookOpenCheck, FileWarning, Loader2 } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { SearchBar } from "@/app/components/ui/search-bar";
import { listPlaybooks, type Playbook } from "@/app/lib/mikeApi";
import { cn } from "@/app/lib/utils";

export type AssistantPlaybookSelection = {
    id: string;
    title: string;
    version: number;
    versionId: string;
};

interface Props {
    open: boolean;
    onClose: () => void;
    onSelect: (playbook: AssistantPlaybookSelection) => void;
    currentId?: string;
}

export function PlaybookPickerModal({
    open,
    onClose,
    onSelect,
    currentId,
}: Props) {
    const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        const load = async () => {
            await Promise.resolve();
            if (cancelled) return;
            setLoading(true);
            setError(null);
            setSearch("");
            try {
                const items = await listPlaybooks();
                if (cancelled) return;
                setPlaybooks(items);
                setSelectedId(
                    items.find((item) => item.id === currentId)?.id ??
                        items.find((item) => item.publishedVersionNumber)?.id ??
                        null,
                );
            } catch (caught) {
                if (cancelled) return;
                setError(
                    caught instanceof Error
                        ? caught.message
                        : "Playbooks could not be loaded.",
                );
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [currentId, open]);

    const filtered = useMemo(() => {
        const query = search.trim().toLowerCase();
        if (!query) return playbooks;
        return playbooks.filter((item) =>
            [
                item.name,
                item.publishedName ?? "",
                item.description,
                item.draft.representedParty,
            ]
                .join(" ")
                .toLowerCase()
                .includes(query),
        );
    }, [playbooks, search]);
    const selected =
        playbooks.find((item) => item.id === selectedId) ?? null;
    const canUse =
        !!selected?.publishedVersionNumber && !!selected.publishedVersionId;

    function useSelected() {
        if (!selected?.publishedVersionNumber || !selected.publishedVersionId)
            return;
        onSelect({
            id: selected.id,
            title: selected.publishedName ?? selected.name,
            version: selected.publishedVersionNumber,
            versionId: selected.publishedVersionId,
        });
        onClose();
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="lg"
            breadcrumbs={["Assistant", "Select playbook"]}
            headerAction={
                <Link
                    href="/playbooks"
                    className="text-xs font-medium text-blue-600 hover:text-blue-700"
                >
                    Manage playbooks
                </Link>
            }
            primaryAction={{
                label: "Use playbook",
                icon: <BookOpenCheck className="h-4 w-4" />,
                disabled: !canUse,
                onClick: useSelected,
            }}
            cancelAction={{ label: "Cancel", onClick: onClose }}
        >
            <div className="flex min-h-0 flex-1 flex-col pb-4">
                <SearchBar
                    value={search}
                    onValueChange={setSearch}
                    placeholder="Search playbooks"
                    wrapperClassName="mb-3 shrink-0"
                />
                {loading ? (
                    <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading playbooks
                    </div>
                ) : error ? (
                    <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                        {error}
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-1 flex-col items-center justify-center text-center">
                        <BookOpenCheck className="h-8 w-8 text-gray-300" />
                        <p className="mt-3 text-sm font-medium text-gray-700">
                            {playbooks.length
                                ? "No playbooks match your search."
                                : "No playbooks are available."}
                        </p>
                        {!playbooks.length && (
                            <Link
                                href="/playbooks"
                                className="mt-2 text-xs font-medium text-blue-600"
                            >
                                Create or import a playbook
                            </Link>
                        )}
                    </div>
                ) : (
                    <div className="grid min-h-0 flex-1 overflow-hidden border-y border-gray-200 sm:grid-cols-[260px_minmax(0,1fr)]">
                        <div className="min-h-0 overflow-y-auto border-r border-gray-200">
                            {filtered.map((item) => {
                                const published = !!item.publishedVersionNumber;
                                return (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => setSelectedId(item.id)}
                                        className={cn(
                                            "block w-full border-b border-gray-100 px-3 py-3 text-left",
                                            selected?.id === item.id
                                                ? "bg-blue-50"
                                                : "hover:bg-gray-50",
                                        )}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <span className="line-clamp-2 text-sm font-medium leading-5 text-gray-800">
                                                {item.publishedName ?? item.name}
                                            </span>
                                            <span
                                                className={cn(
                                                    "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                                                    published
                                                        ? "bg-emerald-50 text-emerald-700"
                                                        : "bg-amber-50 text-amber-700",
                                                )}
                                            >
                                                {published
                                                    ? `v${item.publishedVersionNumber}`
                                                    : "Draft"}
                                            </span>
                                        </div>
                                        <p className="mt-1 truncate text-xs text-gray-400">
                                            {item.draft.representedParty ||
                                                item.description ||
                                                `${item.draft.topics.length} topics`}
                                        </p>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="hidden min-h-0 overflow-y-auto p-5 sm:block">
                            {selected && (
                                <div>
                                    <BookOpenCheck className="h-5 w-5 text-blue-600" />
                                    <h2 className="mt-3 font-serif text-xl text-gray-900">
                                        {selected.publishedName ?? selected.name}
                                    </h2>
                                    <p className="mt-1 text-xs text-gray-500">
                                        {selected.publishedVersionNumber
                                            ? `Published version ${selected.publishedVersionNumber}`
                                            : "Draft only"}
                                        {selected.draft.representedParty
                                            ? ` · Represents ${selected.draft.representedParty}`
                                            : ""}
                                    </p>
                                    {selected.description && (
                                        <p className="mt-4 text-sm leading-6 text-gray-600">
                                            {selected.description}
                                        </p>
                                    )}
                                    <div className="mt-5 space-y-2">
                                        {selected.draft.topics.map((topic) => (
                                            <div
                                                key={topic.id}
                                                className="flex items-center justify-between gap-3 border-b border-gray-100 py-2 text-sm"
                                            >
                                                <span className="truncate text-gray-700">
                                                    {topic.name}
                                                </span>
                                                <span className="shrink-0 text-xs text-gray-400">
                                                    {topic.rules.length} rules
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                    {!selected.publishedVersionNumber && (
                                        <div className="mt-5 flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
                                            <FileWarning className="mt-0.5 h-4 w-4 shrink-0" />
                                            Publish this playbook before using it in Assistant.
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
}
