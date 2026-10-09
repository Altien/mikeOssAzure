import { Download } from "lucide-react";
import type { SkillListItem, SkillPackageInfo } from "./api";

export type SkillPackageKind = "original" | "mike" | "developer";

/** Licence summary and the original / Mike / developer package downloads. */
export function PackagesPanel({
    skill,
    busy,
    packageInfo,
    onShowPackages,
    onDownloadPackage,
}: {
    skill: SkillListItem;
    busy: boolean;
    packageInfo: SkillPackageInfo | undefined;
    onShowPackages: (versionId: string) => void;
    onDownloadPackage: (versionId: string, kind: SkillPackageKind) => void;
}) {
    return (
        <div className="mt-4 border-t border-slate-100 pt-4">
            {!packageInfo ? (
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => onShowPackages(skill.version.id)}
                    className="text-sm text-slate-600 underline-offset-4 hover:underline"
                >
                    Package downloads
                </button>
            ) : (
                <div className="text-sm text-slate-600">
                    <p>
                        {packageInfo.licencePaths.length
                            ? `Includes licence files: ${packageInfo.licencePaths.join(", ")}`
                            : "No licence file was identified in the package."}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() =>
                                onDownloadPackage(skill.version.id, "original")
                            }
                            className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2"
                        >
                            <Download className="h-4 w-4" />
                            Original ZIP
                        </button>
                        <button
                            type="button"
                            onClick={() =>
                                onDownloadPackage(skill.version.id, "mike")
                            }
                            className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2"
                        >
                            <Download className="h-4 w-4" />
                            Mike package
                        </button>
                        {packageInfo.developerPackageAvailable && (
                            <button
                                type="button"
                                onClick={() =>
                                    onDownloadPackage(
                                        skill.version.id,
                                        "developer",
                                    )
                                }
                                className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2"
                            >
                                <Download className="h-4 w-4" />
                                Developer package
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
