"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalFieldLabel } from "@/app/components/modals/ModalFieldLabel";
import { ModalTextInput } from "@/app/components/modals/ModalTextInput";
import {
    createPromptLibraryItem,
    updatePromptLibraryItem,
    type PromptLibraryItem,
    type PromptLibraryInput,
} from "@/app/lib/mikeApi";
import { splitTags } from "./promptLibraryUtils";

type Draft = {
    name: string;
    prompt: string;
    description: string;
    promptType: string;
    categories: string;
    practiceAreas: string;
    sourceRequirements: string;
};

const EMPTY_DRAFT: Draft = {
    name: "",
    prompt: "",
    description: "",
    promptType: "Assist",
    categories: "",
    practiceAreas: "",
    sourceRequirements: "",
};

function draftFromPrompt(prompt: PromptLibraryItem | null): Draft {
    if (!prompt) return EMPTY_DRAFT;
    return {
        name: prompt.name,
        prompt: prompt.prompt,
        description: prompt.description ?? "",
        promptType: prompt.promptType ?? "",
        categories: prompt.categories.join(", "),
        practiceAreas: prompt.practiceAreas.join(", "),
        sourceRequirements: prompt.sourceRequirements.join(", "),
    };
}

export function PromptEditorModal({ open, prompt, onClose, onSaved }: {
    open: boolean;
    prompt: PromptLibraryItem | null;
    onClose: () => void;
    onSaved: (prompt: PromptLibraryItem) => void;
}) {
    const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setDraft(draftFromPrompt(prompt));
        setError(null);
    }, [open, prompt]);

    async function save() {
        if (!draft.name.trim() || !draft.prompt.trim() || saving) return;
        setSaving(true);
        setError(null);
        const payload: PromptLibraryInput = {
            name: draft.name,
            prompt: draft.prompt,
            description: draft.description || null,
            promptType: draft.promptType || null,
            categories: splitTags(draft.categories),
            practiceAreas: splitTags(draft.practiceAreas),
            sourceRequirements: splitTags(draft.sourceRequirements),
        };
        try {
            const saved = prompt
                ? await updatePromptLibraryItem(prompt.id, payload)
                : await createPromptLibraryItem(payload);
            onSaved(saved);
            onClose();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Prompt could not be saved.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal
            open={open}
            onClose={() => !saving && onClose()}
            size="xl"
            breadcrumbs={[prompt ? "Edit prompt" : "New prompt"]}
            primaryAction={{ label: saving ? "Saving" : "Save prompt", icon: saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />, onClick: () => void save(), disabled: saving || !draft.name.trim() || !draft.prompt.trim() }}
            cancelAction={{ label: "Cancel", onClick: onClose, disabled: saving }}
        >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-5 pr-1">
                {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
                <div>
                    <ModalFieldLabel htmlFor="prompt-name">Name</ModalFieldLabel>
                    <ModalTextInput id="prompt-name" value={draft.name} maxLength={160} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Contract indemnity review" />
                </div>
                <div>
                    <ModalFieldLabel htmlFor="prompt-body">Prompt</ModalFieldLabel>
                    <textarea id="prompt-body" value={draft.prompt} maxLength={20000} rows={10} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} className="w-full resize-y rounded-xl border border-white/70 bg-white px-3 py-2.5 text-sm leading-6 text-gray-700 shadow-sm outline-none placeholder:text-gray-400" placeholder="Enter the instructions the model should run..." />
                </div>
                <div>
                    <ModalFieldLabel htmlFor="prompt-description">Description</ModalFieldLabel>
                    <ModalTextInput id="prompt-description" value={draft.description} maxLength={1000} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="Optional note about when to use this prompt" />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                    <div><ModalFieldLabel htmlFor="prompt-type">Type</ModalFieldLabel><ModalTextInput id="prompt-type" value={draft.promptType} maxLength={80} onChange={(event) => setDraft((current) => ({ ...current, promptType: event.target.value }))} placeholder="Assist" /></div>
                    <div><ModalFieldLabel htmlFor="prompt-categories">Categories</ModalFieldLabel><ModalTextInput id="prompt-categories" value={draft.categories} onChange={(event) => setDraft((current) => ({ ...current, categories: event.target.value }))} placeholder="Analyze, Compare" /></div>
                    <div><ModalFieldLabel htmlFor="prompt-practices">Practice areas</ModalFieldLabel><ModalTextInput id="prompt-practices" value={draft.practiceAreas} onChange={(event) => setDraft((current) => ({ ...current, practiceAreas: event.target.value }))} placeholder="Corporate, Commercial Transactions" /></div>
                    <div><ModalFieldLabel htmlFor="prompt-sources">Source requirements</ModalFieldLabel><ModalTextInput id="prompt-sources" value={draft.sourceRequirements} onChange={(event) => setDraft((current) => ({ ...current, sourceRequirements: event.target.value }))} placeholder="Files" /></div>
                </div>
                <p className="text-xs leading-5 text-gray-400">Separate multiple categories, practice areas, or source requirements with commas.</p>
            </div>
        </Modal>
    );
}
