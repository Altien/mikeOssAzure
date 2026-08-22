import { describe, expect, it, vi } from "vitest";
import {
    collectDroppedDocumentUploadEntries,
    documentUploadEntriesFromFiles,
    documentUploadFolderSegments,
    documentUploadPathSegments,
    documentUploadProgressEntries,
    resolveDocumentUploadRootFolder,
} from "./documentDirectoryUpload";

function folderFile(name: string, relativePath: string) {
    const file = new File([name], name);
    Object.defineProperty(file, "webkitRelativePath", {
        value: relativePath,
    });
    return file;
}

describe("document directory upload paths", () => {
    it("preserves the selected root folder and nested subfolders", () => {
        const file = folderFile(
            "agreement.pdf",
            "Matter/Contracts/Executed/agreement.pdf",
        );
        const [entry] = documentUploadEntriesFromFiles([file]);

        expect(entry.relativePath).toBe(
            "Matter/Contracts/Executed/agreement.pdf",
        );
        expect(documentUploadFolderSegments(entry)).toEqual([
            "Matter",
            "Contracts",
            "Executed",
        ]);
    });

    it("uploads ordinary files directly into the target folder", () => {
        const file = new File(["memo"], "memo.docx");
        const [entry] = documentUploadEntriesFromFiles([file]);

        expect(documentUploadPathSegments(entry)).toEqual(["memo.docx"]);
        expect(documentUploadFolderSegments(entry)).toEqual([]);
    });

    it("summarizes a selected directory as one top-level folder row", () => {
        const entries = documentUploadEntriesFromFiles([
            folderFile("agreement.pdf", "Matter/Contracts/agreement.pdf"),
            folderFile("memo.docx", "Matter/Advice/memo.docx"),
        ]);

        expect(documentUploadProgressEntries(entries)).toEqual([
            { kind: "folder", name: "Matter" },
        ]);
    });

    it("keeps direct files as file rows alongside dropped folders", () => {
        const entries = [
            ...documentUploadEntriesFromFiles([
                folderFile("agreement.pdf", "Matter/agreement.pdf"),
            ]),
            ...documentUploadEntriesFromFiles([
                new File(["memo"], "memo.docx"),
            ]),
        ];

        expect(documentUploadProgressEntries(entries)).toEqual([
            { kind: "folder", name: "Matter" },
            { kind: "file", name: "memo.docx" },
        ]);
    });

    it("normalizes separators and excludes traversal segments", () => {
        const file = new File(["memo"], "memo.docx");
        expect(
            documentUploadPathSegments({
                file,
                relativePath: "Matter\\.\\..\\Advice\\memo.docx",
            }),
        ).toEqual(["Matter", "Advice", "memo.docx"]);
    });

    it("recursively traverses dropped folders and all directory batches", async () => {
        const agreement = new File(["agreement"], "agreement.pdf");
        const advice = new File(["advice"], "advice.docx");
        const fileEntry = (file: File) => ({
            isFile: true,
            isDirectory: false,
            name: file.name,
            file: (resolve: (value: File) => void) => resolve(file),
        });
        const directoryEntry = (
            name: string,
            batches: unknown[][],
        ) => ({
            isFile: false,
            isDirectory: true,
            name,
            createReader: () => {
                let index = 0;
                return {
                    readEntries: (resolve: (entries: unknown[]) => void) =>
                        resolve(batches[index++] ?? []),
                };
            },
        });
        const nested = directoryEntry("Advice", [[fileEntry(advice)], []]);
        const root = directoryEntry("Matter", [
            [fileEntry(agreement)],
            [nested],
            [],
        ]);
        const dataTransfer = {
            items: [
                {
                    kind: "file",
                    webkitGetAsEntry: () => root,
                },
            ],
            files: [],
        } as unknown as DataTransfer;

        const entries = await collectDroppedDocumentUploadEntries(
            dataTransfer,
        );
        expect(entries.map((entry) => entry.relativePath)).toEqual([
            "Matter/agreement.pdf",
            "Matter/Advice/advice.docx",
        ]);
    });

    it("deletes an existing folder before resolving a replacement", async () => {
        const calls: string[] = [];
        const resolveFolderPath = vi
            .fn()
            .mockImplementationOnce(async () => ({
                conflict: true as const,
                folder_name: "NDAs",
                existing_folder_id: "old-folder",
                suggested_name: "NDAs (2)",
                can_replace: true,
            }))
            .mockImplementationOnce(async () => {
                calls.push("resolve-new-folder");
                return {
                    conflict: false as const,
                    folder_id: "new-folder",
                    resolved_name: "NDAs",
                    folders: [],
                };
            });
        const replaceFolder = vi.fn(async () => {
            calls.push("delete-old-folder");
        });

        const result = await resolveDocumentUploadRootFolder({
            rootFolderName: "NDAs",
            baseFolderId: null,
            resolveFolderPath,
            chooseConflict: async () => "replace",
            replaceFolder,
        });

        expect(calls).toEqual(["delete-old-folder", "resolve-new-folder"]);
        expect(replaceFolder).toHaveBeenCalledWith("old-folder");
        expect(result).toMatchObject({
            conflict: false,
            folder_id: "new-folder",
            resolved_name: "NDAs",
        });
    });

    it("creates a suffixed folder without deleting the existing one", async () => {
        const resolveFolderPath = vi
            .fn()
            .mockResolvedValueOnce({
                conflict: true as const,
                folder_name: "NDAs",
                existing_folder_id: "old-folder",
                suggested_name: "NDAs (2)",
                can_replace: true,
            })
            .mockResolvedValueOnce({
                conflict: false as const,
                folder_id: "new-folder",
                resolved_name: "NDAs (2)",
                folders: [],
            });
        const replaceFolder = vi.fn(async () => {});

        const result = await resolveDocumentUploadRootFolder({
            rootFolderName: "NDAs",
            baseFolderId: null,
            resolveFolderPath,
            chooseConflict: async () => "rename",
            replaceFolder,
        });

        expect(replaceFolder).not.toHaveBeenCalled();
        expect(resolveFolderPath).toHaveBeenLastCalledWith(
            ["NDAs"],
            null,
            "rename",
        );
        expect(result?.resolved_name).toBe("NDAs (2)");
    });
});
