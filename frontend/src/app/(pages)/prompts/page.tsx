"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, BookOpenText, FileText, Loader2, Pencil, Play, Search, Trash2 } from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { Modal } from "@/app/components/modals/Modal";
import { PillButton } from "@/app/components/ui/pill-button";
import { PromptEditorModal } from "@/app/components/prompts/PromptEditorModal";
import { filterPrompts, promptCategories } from "@/app/components/prompts/promptLibraryUtils";
import { deletePromptLibraryItem, listPromptLibrary, type PromptLibraryItem } from "@/app/lib/mikeApi";
import { cn } from "@/app/lib/utils";

type SourceFilter = "all" | "built_in" | "user";

export default function PromptLibraryPage() {
    const router = useRouter();
    const [prompts, setPrompts] = useState<PromptLibraryItem[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState<string | null>(null);
    const [source, setSource] = useState<SourceFilter>("all");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [editing, setEditing] = useState<PromptLibraryItem | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);

    useEffect(() => {
        listPromptLibrary()
            .then((items) => {
                setPrompts(items);
                setSelectedId(items[0]?.id ?? null);
            })
            .catch((caught) => setError(caught instanceof Error ? caught.message : "Prompts could not be loaded."))
            .finally(() => setLoading(false));
    }, []);

    const categories = useMemo(() => promptCategories(prompts), [prompts]);
    const filtered = useMemo(() => filterPrompts(prompts, search, category, source), [prompts, search, category, source]);
    const selectedById = prompts.find((prompt) => prompt.id === selectedId) ?? null;
    const selected = selectedById && filtered.some((prompt) => prompt.id === selectedById.id)
        ? selectedById
        : filtered[0] ?? null;

    useEffect(() => {
        if (selected && filtered.some((prompt) => prompt.id === selected.id)) return;
        setSelectedId(filtered[0]?.id ?? null);
    }, [filtered, selected]);

    function openCreate() {
        setEditing(null);
        setEditorOpen(true);
    }

    function openEdit() {
        if (!selected || selected.source !== "user") return;
        setEditing(selected);
        setEditorOpen(true);
    }

    function handleSaved(saved: PromptLibraryItem) {
        setPrompts((current) => [saved, ...current.filter((prompt) => prompt.id !== saved.id)]);
        setSelectedId(saved.id);
        setSource("all");
        setCategory(null);
    }

    async function removeSelected() {
        if (!selected || selected.source !== "user" || deleting) return;
        setDeleting(true);
        setError(null);
        try {
            await deletePromptLibraryItem(selected.id);
            setPrompts((current) => current.filter((prompt) => prompt.id !== selected.id));
            setSelectedId(null);
            setConfirmDelete(false);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Prompt could not be deleted.");
        } finally {
            setDeleting(false);
        }
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader breadcrumbs={[{ label: "Prompt library" }]} actions={[{ type: "new", onClick: openCreate, disabled: loading }]} />
            {error && <div role="alert" className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 md:mx-6"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">{error}</span><button type="button" onClick={() => setError(null)} className="text-xs font-medium">Dismiss</button></div>}

            <div className="mx-4 mb-3 flex shrink-0 flex-wrap items-center gap-2 md:mx-6">
                <div className="relative min-w-[220px] flex-1 md:max-w-md"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search prompts" className="h-9 w-full rounded-md border border-gray-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-blue-300" /></div>
                <div className="flex rounded-md border border-gray-200 bg-white p-0.5">
                    {([{"id":"all","label":"All"},{"id":"built_in","label":"Built-in"},{"id":"user","label":"Mine"}] as const).map((item) => <button key={item.id} type="button" onClick={() => setSource(item.id)} className={cn("rounded px-3 py-1.5 text-xs font-medium", source === item.id ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-50")}>{item.label}</button>)}
                </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden md:grid-cols-[170px_330px_minmax(0,1fr)] md:grid-rows-1">
                <aside className="flex max-w-full gap-1 overflow-x-auto border-b border-gray-200 px-4 pb-3 md:block md:overflow-y-auto md:border-b-0 md:border-r md:px-3 md:pb-4">
                    <CategoryButton label="All categories" count={prompts.length} active={!category} onClick={() => setCategory(null)} />
                    {categories.map((item) => <CategoryButton key={item.name} label={item.name} count={item.count} active={category === item.name} onClick={() => setCategory(item.name)} />)}
                </aside>

                <section className="hidden min-h-0 overflow-y-auto border-r border-gray-200 md:block">
                    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-4 py-3"><span className="text-xs font-semibold uppercase text-gray-400">Prompts</span><span className="text-xs text-gray-400">{filtered.length}</span></div>
                    {loading ? <LoadingState /> : filtered.length ? filtered.map((prompt) => <PromptRow key={prompt.id} prompt={prompt} active={selected?.id === prompt.id} onClick={() => setSelectedId(prompt.id)} />) : <p className="p-5 text-sm text-gray-400">No prompts match these filters.</p>}
                </section>

                <main className="min-h-0 overflow-y-auto">
                    <div className="border-b border-gray-200 md:hidden">{loading ? <LoadingState /> : filtered.map((prompt) => <PromptRow key={prompt.id} prompt={prompt} active={selected?.id === prompt.id} onClick={() => setSelectedId(prompt.id)} />)}</div>
                    {selected ? <PromptDetail prompt={selected} onRun={() => router.push(`/assistant?prompt=${encodeURIComponent(selected.id)}`)} onEdit={openEdit} onDelete={() => setConfirmDelete(true)} /> : !loading && <div className="flex h-full min-h-64 items-center justify-center px-6 text-center"><div><BookOpenText className="mx-auto h-8 w-8 text-gray-300" /><p className="mt-3 text-sm text-gray-500">No prompt selected.</p></div></div>}
                </main>
            </div>

            <PromptEditorModal open={editorOpen} prompt={editing} onClose={() => setEditorOpen(false)} onSaved={handleSaved} />
            <Modal open={confirmDelete} onClose={() => !deleting && setConfirmDelete(false)} size="sm" breadcrumbs={["Delete prompt"]} primaryAction={{ label: deleting ? "Deleting" : "Delete", variant: "danger", icon: deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />, onClick: () => void removeSelected(), disabled: deleting }} cancelAction={{ label: "Cancel", onClick: () => setConfirmDelete(false), disabled: deleting }}><p className="py-6 text-sm leading-6 text-gray-600">Delete <strong>{selected?.name}</strong>?</p></Modal>
        </div>
    );
}

function CategoryButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
    return <button type="button" onClick={onClick} className={cn("flex shrink-0 items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-xs md:w-full", active ? "bg-gray-100 font-medium text-gray-800" : "text-gray-500 hover:bg-gray-50")}><span className="truncate">{label}</span><span className="text-gray-400">{count}</span></button>;
}

function PromptRow({ prompt, active, onClick }: { prompt: PromptLibraryItem; active: boolean; onClick: () => void }) {
    return <button type="button" onClick={onClick} className={cn("block w-full border-b border-gray-100 px-4 py-3 text-left", active ? "bg-blue-50" : "hover:bg-gray-50")}><div className="flex items-start gap-2"><FileText className={cn("mt-0.5 h-4 w-4 shrink-0", prompt.source === "user" ? "text-emerald-600" : "text-blue-600")} /><div className="min-w-0"><p className="line-clamp-2 text-sm font-medium leading-5 text-gray-800">{prompt.name}</p><p className="mt-1 truncate text-xs text-gray-400">{prompt.categories.join(" · ") || prompt.promptType || "General"}</p></div></div></button>;
}

function PromptDetail({ prompt, onRun, onEdit, onDelete }: { prompt: PromptLibraryItem; onRun: () => void; onEdit: () => void; onDelete: () => void }) {
    return <div className="mx-auto w-full max-w-4xl py-6 pl-16 pr-5 md:px-8"><div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-5"><div className="min-w-0"><p className="text-xs font-medium text-gray-400">{prompt.source === "built_in" ? "Built-in prompt" : "My prompt"}{prompt.promptType ? ` · ${prompt.promptType}` : ""}</p><h1 className="mt-2 break-words font-serif text-2xl text-gray-900">{prompt.name}</h1>{prompt.description && <p className="mt-2 text-sm leading-6 text-gray-500">{prompt.description}</p>}</div><div className="flex gap-2"><PillButton tone="black" size="normal" onClick={onRun}><Play className="h-4 w-4" />Use prompt</PillButton>{prompt.source === "user" && <><button type="button" onClick={onEdit} aria-label="Edit prompt" title="Edit prompt" className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100"><Pencil className="h-4 w-4" /></button><button type="button" onClick={onDelete} aria-label="Delete prompt" title="Delete prompt" className="flex h-9 w-9 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></>}</div></div><div className="mt-4 flex flex-wrap gap-2">{prompt.categories.map((tag) => <span key={tag} className="rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-700">{tag}</span>)}{prompt.practiceAreas.map((tag) => <span key={tag} className="rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600">{tag}</span>)}{prompt.sourceRequirements.map((tag) => <span key={tag} className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700">Requires {tag.toLowerCase()}</span>)}</div><section className="mt-6"><h2 className="text-xs font-semibold uppercase text-gray-400">Prompt</h2><p className="mt-3 whitespace-pre-wrap border-l-2 border-gray-200 pl-4 text-sm leading-7 text-gray-700">{prompt.prompt}</p></section>{prompt.originalCreator && <p className="mt-8 text-xs text-gray-400">Imported example originally created by {prompt.originalCreator}</p>}</div>;
}

function LoadingState() {
    return <div className="flex items-center gap-2 p-5 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Loading prompts</div>;
}
