import { Trash2 } from "lucide-react";
import type { SkillListItem } from "./api";

/**
 * Removes an import that should never have entered the library.
 *
 * Draft only. An enabled or disabled version can be pinned by a project or
 * bound to a running chat, and the server refuses to delete one — a promoted
 * version is retired by disabling the skill, which leaves running chats
 * intact. The click only *requests* the delete; the library confirms it
 * through the shared ConfirmPopup so it is never a single misclick.
 */
export function DeleteDraftPanel({
    skill,
    busy,
    onRequestDelete,
}: {
    skill: SkillListItem;
    busy: boolean;
    onRequestDelete: (skill: SkillListItem) => void;
}) {
    if (skill.version.state !== "draft") return null;
    return (
        <div className="mt-3 border-t border-slate-100 pt-3">
            <button
                type="button"
                disabled={busy}
                onClick={() => onRequestDelete(skill)}
                className="inline-flex items-center gap-2 rounded-md border border-red-200 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
                <Trash2 className="h-4 w-4" />
                Delete draft
            </button>
            <p className="mt-2 text-xs text-slate-500">
                Deletes this draft version with its review conversation,
                generated briefs, and the preserved snapshot it created.
            </p>
        </div>
    );
}
