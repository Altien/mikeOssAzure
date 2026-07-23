import { describe, it, expect } from "vitest";
import {
    isSupportedDocumentFile,
    partitionSupportedDocumentFiles,
    formatUnsupportedDocumentWarning,
    SUPPORTED_DOCUMENT_ACCEPT,
    UNSUPPORTED_DOCUMENT_WARNING_MESSAGE,
} from "./documentUploadValidation";

const file = (name: string) => new File([""], name);

describe("isSupportedDocumentFile", () => {
    it("accepts pdf/docx/doc, case-insensitively", () => {
        for (const name of ["a.pdf", "b.DOCX", "c.Doc", "multi.part.PDF"]) {
            expect(isSupportedDocumentFile(file(name))).toBe(true);
        }
    });

    it("rejects other extensions and extensionless names", () => {
        for (const name of ["a.txt", "b.xlsx", "c.pdf.exe", "noextension", ""]) {
            expect(isSupportedDocumentFile(file(name))).toBe(false);
        }
    });

    it("stays in sync with the <input accept> attribute", () => {
        // If someone extends one list but not the other, uploads either
        // get silently filtered or the picker hides valid files.
        const acceptExts = SUPPORTED_DOCUMENT_ACCEPT.split(",").map((e) =>
            e.replace(".", ""),
        );
        for (const ext of acceptExts) {
            expect(isSupportedDocumentFile(file(`x.${ext}`))).toBe(true);
        }
    });
});

describe("partitionSupportedDocumentFiles", () => {
    it("splits files preserving order within each bucket", () => {
        const files = [file("a.pdf"), file("b.txt"), file("c.docx"), file("d.png")];

        const { supported, unsupported } = partitionSupportedDocumentFiles(files);

        expect(supported.map((f) => f.name)).toEqual(["a.pdf", "c.docx"]);
        expect(unsupported.map((f) => f.name)).toEqual(["b.txt", "d.png"]);
    });
});

describe("formatUnsupportedDocumentWarning", () => {
    it("returns null for an empty list and the fixed message otherwise", () => {
        expect(formatUnsupportedDocumentWarning([])).toBeNull();
        expect(formatUnsupportedDocumentWarning([file("a.txt")])).toBe(
            UNSUPPORTED_DOCUMENT_WARNING_MESSAGE,
        );
    });
});
