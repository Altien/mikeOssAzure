import type { PromptLibraryItem } from "@/app/lib/mikeApi";

export function promptCategories(prompts: PromptLibraryItem[]): Array<{ name: string; count: number }> {
    const counts = new Map<string, number>();
    for (const prompt of prompts) {
        for (const category of prompt.categories) counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function filterPrompts(prompts: PromptLibraryItem[], search: string, category: string | null, source: "all" | "built_in" | "user" = "all"): PromptLibraryItem[] {
    const query = search.trim().toLowerCase();
    return prompts.filter((prompt) => {
        if (source !== "all" && prompt.source !== source) return false;
        if (category && !prompt.categories.includes(category)) return false;
        if (!query) return true;
        return [prompt.name, prompt.prompt, prompt.description ?? "", prompt.promptType ?? "", ...prompt.categories, ...prompt.practiceAreas]
            .join(" ")
            .toLowerCase()
            .includes(query);
    });
}

export function splitTags(value: string): string[] {
    return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}
