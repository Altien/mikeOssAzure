export interface ContextSuffixOptions {
    editMode?: unknown;
    creationMode?: unknown;
    selection?: unknown;
}

const MAX_SELECTION_PREVIEW = 500;

function selectedText(selection: unknown): string | null {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
        return null;
    }
    const row = selection as Record<string, unknown>;
    if (row.has_selection !== true || typeof row.text !== "string") return null;
    const text = row.text.trim();
    if (!text) return null;
    return text.length > MAX_SELECTION_PREVIEW
        ? `${text.slice(0, MAX_SELECTION_PREVIEW)}...`
        : text;
}

export function buildContextSuffix(options: ContextSuffixOptions): string {
    const sections: string[] = [];

    if (options.editMode === "comments") {
        sections.push(
            "WORD EDIT MODE - COMMENTS:\n" +
                "When proposing document changes, return a fenced JSON block with an edits array. Each edit must contain exact `find` text, minimal `replace` text, and a complete standalone `reason` suitable for a Word comment. For advisory-only comments, `replace` may equal `find`.",
        );
    } else if (options.editMode === "track") {
        sections.push(
            "WORD EDIT MODE - TRACK CHANGES:\n" +
                "When proposing document changes, return a fenced JSON block with an edits array. Each edit must contain exact `find` text, minimal `replace` text, and a brief factual `reason`. The Word client applies each replacement with change tracking and adds the reason as a comment.",
        );
    }

    if (options.creationMode === "this_word_doc") {
        sections.push(
            "WORD CREATION MODE - CURRENT DOCUMENT:\n" +
                "Do not call generate_docx. End the response with a fenced JSON block in this form:\n" +
                "```json\n" +
                '{"writes":[{"at":"selection|end|after_selection","content_md":"..."}]}\n' +
                "```\n" +
                "Use `selection` for insert-here or cursor requests, `after_selection` when content follows the selected passage, and `end` for append or unclear requests. Put clean light markdown in `content_md`.",
        );
    } else if (options.creationMode === "project") {
        sections.push(
            "WORD CREATION MODE - PROJECT DOCUMENT:\n" +
                "When the user asks for a new document, use generate_docx to create a separate project file.",
        );
    }

    const selection = selectedText(options.selection);
    if (selection) {
        sections.push(
            "ACTIVE WORD SELECTION:\n" +
                "Scope edits and inserted content to the selected text unless the user explicitly asks for a broader review. Use the rest of the document only for style and terminology context.\n---\n" +
                selection +
                "\n---",
        );
    }

    return sections.join("\n\n");
}
