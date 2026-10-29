import type { ModelOption } from "@/shared/lib/modelCatalog";
import { modelDisplayName } from "@/shared/lib/modelCatalog";
import type {
    ApiKeyState,
    PlaybookConfiguration,
} from "@/app/lib/mikeApi";

export function buildPlaybookModelOptions(
    catalog: ModelOption[],
    configuration: PlaybookConfiguration | null,
    apiKeys?: ApiKeyState,
): Array<{ value: string; label: string }> {
    if (!configuration) return [];
    const serverAvailable = new Set(configuration.availableModelIds);
    const choices = catalog
        .filter(
            (model) =>
                serverAvailable.has(model.id),
        )
        .map((model) => ({
            value: model.id,
            label: `${model.group} · ${model.label}`,
        }));
    // The server validates managed credentials and the current organization model lists.
    const known = new Set(choices.map((choice) => choice.value));
    return [...choices, ...configuration.availableModelIds.filter((id) => !known.has(id)).map((id) => ({ value: id, label: modelDisplayName(id) }))];
}
