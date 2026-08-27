"use client";

import { useEffect, useMemo, useState } from "react";
import { BookOpenText, FileText, Loader2, Search } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { listPromptLibrary, type PromptLibraryItem } from "@/app/lib/mikeApi";
import { cn } from "@/app/lib/utils";
import { filterPrompts, promptCategories } from "./promptLibraryUtils";

export function PromptPickerModal({ open, onClose, onSelect }: {
    open: boolean;
    onClose: () => void;
    onSelect: (prompt: PromptLibraryItem) => void;
}) {
    const [prompts, setPrompts] = useState<PromptLibraryItem[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open || prompts.length) return;
        listPromptLibrary()
            .then((items) => {
                setPrompts(items);
                setSelectedId(items[0]?.id ?? null);
            })
            .catch((caught) => setError(caught instanceof Error ? caught.message : "Prompts could not be loaded."))
            .finally(() => setLoading(false));
    }, [open, prompts.length]);

    const categories = useMemo(() => promptCategories(prompts), [prompts]);
    const filtered = useMemo(() => filterPrompts(prompts, search, category), [prompts, search, category]);
    const selectedById = prompts.find((prompt) => prompt.id === selectedId) ?? null;
    const selected = selectedById && filtered.some((prompt) => prompt.id === selectedById.id)
        ? selectedById
        : filtered[0] ?? null;

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="xl"
            breadcrumbs={["Prompt library"]}
            primaryAction={{ label: "Use prompt", icon: <BookOpenText className="h-4 w-4" />, disabled: !selected, onClick: () => { if (selected) onSelect(selected); } }}
            cancelAction={{ label: "Cancel", onClick: onClose }}
        >
            <div className="flex min-h-0 flex-1 flex-col pb-4">
                <div className="relative mb-3 shrink-0">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search prompts, categories, or practice areas" className="h-10 w-full rounded-md border border-gray-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-blue-300" />
                </div>
                {loading ? <div className="flex flex-1 items-center justify-center text-sm text-gray-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading prompts</div> : error ? <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : (
                    <div className="grid min-h-0 flex-1 overflow-hidden border-y border-gray-200 md:grid-cols-[150px_270px_minmax(0,1fr)]">
                        <aside className="hidden overflow-y-auto border-r border-gray-200 py-2 md:block">
                            <CategoryButton label="All prompts" count={prompts.length} active={!category} onClick={() => setCategory(null)} />
                            {categories.map((item) => <CategoryButton key={item.name} label={item.name} count={item.count} active={category === item.name} onClick={() => setCategory(item.name)} />)}
                        </aside>
                        <div className="min-h-0 overflow-y-auto border-r border-gray-200">
                            {filtered.length ? filtered.map((prompt) => (
                                <button key={prompt.id} type="button" onClick={() => setSelectedId(prompt.id)} className={cn("block w-full border-b border-gray-100 px-3 py-3 text-left", selected?.id === prompt.id ? "bg-blue-50" : "hover:bg-gray-50")}>
                                    <p className="line-clamp-2 text-sm font-medium leading-5 text-gray-800">{prompt.name}</p>
                                    <p className="mt-1 truncate text-xs text-gray-400">{prompt.categories.join(" · ") || prompt.promptType || "General"}</p>
                                </button>
                            )) : <p className="p-4 text-sm text-gray-400">No prompts match this search.</p>}
                        </div>
                        <div className="hidden min-h-0 overflow-y-auto p-5 sm:block">
                            {selected && <PromptPreview prompt={selected} />}
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
}

function CategoryButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
    return <button type="button" onClick={onClick} className={cn("flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs", active ? "bg-gray-100 font-medium text-gray-800" : "text-gray-500 hover:bg-gray-50")}><span className="truncate">{label}</span><span className="text-gray-400">{count}</span></button>;
}

function PromptPreview({ prompt }: { prompt: PromptLibraryItem }) {
    return <div><div className="flex items-start gap-3"><FileText className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" /><div><h2 className="font-serif text-xl text-gray-900">{prompt.name}</h2><p className="mt-1 text-xs text-gray-400">{prompt.source === "built_in" ? "Built-in example" : "My prompt"}{prompt.promptType ? ` · ${prompt.promptType}` : ""}</p></div></div><div className="mt-4 flex flex-wrap gap-1.5">{prompt.categories.map((tag) => <span key={tag} className="rounded-md bg-blue-50 px-2 py-1 text-[11px] text-blue-700">{tag}</span>)}{prompt.sourceRequirements.map((tag) => <span key={tag} className="rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-700">Requires {tag.toLowerCase()}</span>)}</div><p className="mt-5 whitespace-pre-wrap text-sm leading-6 text-gray-600">{prompt.prompt}</p></div>;
}
