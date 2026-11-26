import { describe, expect, it } from "vitest";
import {
    emailDocumentFilename,
    emailToMarkdown,
    htmlToMarkdown,
    MAX_EMAIL_ATTACHMENTS,
    MAX_EMAIL_NESTING_DEPTH,
    newEmailImportBudget,
} from "./email";

const PDF_BASE64 = "JVBERi0xLjQKJSVFT0YK"; // "%PDF-1.4\n%%EOF\n", 15 bytes

const FIXTURE = [
    'From: "Ann Example" <ann@example.com>',
    "To: bob@example.com",
    "Cc: Carol <carol@example.com>",
    "Date: Tue, 10 Nov 2026 09:30:00 +0000",
    "Subject: =?UTF-8?B?UmU6IENvbnRyYWN0IOKAkyBjbMOhdXNlIDc=?=",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Hi Bob,",
    "",
    "The fee is =E2=82=AC500 =3D final. This line is soft-=",
    "wrapped.",
    "# not a heading",
    "",
    "> Earlier: agreed?",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>HTML version</p>",
    "--alt--",
    "--outer",
    'Content-Type: application/pdf; name="draft.pdf"',
    'Content-Disposition: attachment; filename="draft.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    PDF_BASE64,
    "--outer",
    'Content-Type: application/zip; name="bundle.zip"',
    'Content-Disposition: attachment; filename="bundle.zip"',
    "Content-Transfer-Encoding: base64",
    "",
    "UEsDBA==",
    "--outer--",
    "",
].join("\r\n");

const encode = (text: string) => new TextEncoder().encode(text);

function message(options: { html?: string; parts?: string[]; subject?: string }): string {
    const subject = options.subject ?? "Test";
    // Per subject, so a message nested in another has a boundary of its own.
    const boundary = `b-${subject}`;
    const separator = `--${boundary}`;
    const lines = [
        "From: ann@example.com",
        "To: bob@example.com",
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        separator,
        "Content-Type: text/html; charset=utf-8",
        "",
        options.html ?? "<p>Body</p>",
    ];
    for (const part of options.parts ?? []) lines.push(separator, part);
    lines.push(`${separator}--`, "");
    return lines.join("\r\n");
}

function pdfPart(filename: string): string {
    return [
        `Content-Type: application/pdf; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        PDF_BASE64,
    ].join("\r\n");
}

function emlPart(filename: string, raw: string): string {
    return [
        "Content-Type: message/rfc822",
        `Content-Disposition: attachment; filename="${filename}"`,
        "",
        raw,
    ].join("\r\n");
}

describe("emailToMarkdown", () => {
    it("writes headers, the plain-text body and what became of each attachment", async () => {
        const { markdown, attachments } = await emailToMarkdown(encode(FIXTURE), {
            emailFilename: "Contract.eml",
            budget: newEmailImportBudget(),
        });

        expect(markdown).toContain("# Re: Contract – cláuse 7");
        expect(markdown).toContain("**From:** Ann Example \\<ann@example.com\\>");
        expect(markdown).toContain("**Cc:** Carol \\<carol@example.com\\>");
        expect(markdown).toContain("**Date:** Tue, 10 Nov 2026 09:30:00 +0000");
        expect(markdown).toContain("The fee is €500 = final. This line is soft-wrapped.  \n\\# not a heading");
        expect(markdown).toContain("> Earlier: agreed?");
        // The plain-text part wins over the HTML one.
        expect(markdown).not.toContain("HTML version");
        expect(markdown).toContain('- draft.pdf (15 B): imported as document "Contract.eml - draft.pdf"');
        expect(markdown).toContain("- bundle.zip (4 B): not imported: unsupported type");

        expect(attachments).toHaveLength(1);
        expect(attachments[0].filename).toBe("Contract.eml - draft.pdf");
        expect(attachments[0].fileType).toBe("pdf");
        expect(new TextDecoder().decode(attachments[0].content)).toBe("%PDF-1.4\n%%EOF\n");
    });

    it("converts an HTML-only body, keeping structure and dropping anything active or remote", async () => {
        const html = [
            "<html><head><style>body{background:url(https://x.example/bg.png)}</style>",
            "<script>alert(1)</script></head><body>",
            "<h2>Terms</h2>",
            "<p>Please <b>sign</b> <i>today</i>, see <a href=\"https://example.com/deal\">the deal room</a>.</p>",
            "<ul><li>First</li><li>Second</li></ul>",
            "<table><tr><th>Item</th><th>Fee</th></tr><tr><td>Review</td><td>500</td></tr></table>",
            "<blockquote>On Monday Bob wrote: agreed</blockquote>",
            '<img src="https://tracker.example/pixel.png" alt="Logo">',
            '<img src="cid:sig@x">',
            "<iframe src=\"https://evil.example\"></iframe>",
            "</body></html>",
        ].join("");
        const { markdown } = await emailToMarkdown(encode(message({ html })), {
            emailFilename: "Terms.eml",
            budget: newEmailImportBudget(),
        });

        expect(markdown).toContain("## Terms");
        expect(markdown).toContain("**sign**");
        expect(markdown).toContain("_today_");
        expect(markdown).toContain("[the deal room](https://example.com/deal)");
        expect(markdown).toMatch(/- First\n- Second/);
        expect(markdown).toMatch(/\| Item +\| Fee \|\n\| -+ \| -+ \|\n\| Review \| 500 \|/);
        expect(markdown).toContain("> On Monday Bob wrote: agreed");
        expect(markdown).toContain("[image: Logo]");
        expect(markdown).not.toMatch(/alert|<script|<style|tracker\.example|cid:|evil\.example|!\[/);
    });

    it("leaves inline cid: images out of the attachments", async () => {
        const raw = [
            "From: ann@example.com",
            "Subject: Signature",
            "MIME-Version: 1.0",
            'Content-Type: multipart/related; boundary="r"',
            "",
            "--r",
            "Content-Type: text/html; charset=utf-8",
            "",
            '<p>Hi</p><img src="cid:logo@x" alt="Firm logo">',
            "--r",
            "Content-Type: image/png",
            "Content-ID: <logo@x>",
            "Content-Disposition: inline",
            "Content-Transfer-Encoding: base64",
            "",
            "iVBORw0KGgo=",
            "--r--",
            "",
        ].join("\r\n");
        const { markdown, attachments } = await emailToMarkdown(encode(raw), {
            emailFilename: "Signature.eml",
            budget: newEmailImportBudget(),
        });
        expect(markdown).toContain("[image: Firm logo]");
        expect(markdown).not.toContain("Attachments");
        expect(attachments).toEqual([]);
    });

    it("stops importing once the attachment count or byte budget is spent", async () => {
        const parts = Array.from({ length: MAX_EMAIL_ATTACHMENTS + 2 }, (_, index) => pdfPart(`p${index}.pdf`));
        const budget = newEmailImportBudget();
        const { markdown, attachments } = await emailToMarkdown(encode(message({ parts })), {
            emailFilename: "Many.eml",
            budget,
        });
        expect(attachments).toHaveLength(MAX_EMAIL_ATTACHMENTS);
        expect(budget.attachments).toBe(0);
        expect(markdown.match(/not imported: over limit/g)).toHaveLength(2);

        const small = { attachments: 10, bytes: 20 };
        const twoPdfs = message({ parts: [pdfPart("a.pdf"), pdfPart("b.pdf")] });
        const bytesCapped = await emailToMarkdown(encode(twoPdfs), { emailFilename: "Two.eml", budget: small });
        expect(bytesCapped.attachments.map((item) => item.filename)).toEqual(["Two.eml - a.pdf"]);
        expect(bytesCapped.markdown).toContain("b.pdf (15 B): not imported: over limit");
        expect(small).toEqual({ attachments: 9, bytes: 5 });
    });

    it("hands nested emails back for the same conversion, up to the depth cap", async () => {
        const inner = message({ subject: "Inner", html: "<p>Inner body</p>" });
        const outer = message({ parts: [emlPart("Fwd.eml", inner)] });

        const top = await emailToMarkdown(encode(outer), { emailFilename: "Outer.eml", budget: newEmailImportBudget() });
        expect(top.attachments.map((item) => [item.filename, item.fileType])).toEqual([["Outer.eml - Fwd.eml", "eml"]]);
        expect(top.markdown).toContain('imported as document "Outer.eml - Fwd.eml.md"');
        const nested = await emailToMarkdown(top.attachments[0].content, {
            emailFilename: top.attachments[0].filename,
            budget: newEmailImportBudget(),
            depth: 1,
        });
        expect(nested.markdown).toContain("# Inner");
        expect(nested.markdown).toContain("Inner body");

        const deepest = await emailToMarkdown(encode(outer), {
            emailFilename: "Deep.eml",
            budget: newEmailImportBudget(),
            depth: MAX_EMAIL_NESTING_DEPTH,
        });
        expect(deepest.attachments).toEqual([]);
        expect(deepest.markdown).toContain("Fwd.eml");
        expect(deepest.markdown).toContain("not imported: emails nested too deeply");
    });

    it("strips paths and control characters from attachment names", async () => {
        const raw = message({ parts: [pdfPart("../../etc/evil.pdf")] });
        const { attachments } = await emailToMarkdown(encode(raw), { emailFilename: "E.eml", budget: newEmailImportBudget() });
        expect(attachments[0].filename).toBe("E.eml - evil.pdf");
    });
});

describe("emailDocumentFilename", () => {
    it("keeps the email's name visible", () => {
        expect(emailDocumentFilename("Contract.eml")).toBe("Contract.eml.md");
        expect(emailDocumentFilename(`${"x".repeat(300)}.eml`)).toHaveLength(255);
    });
});

describe("htmlToMarkdown", () => {
    it("drops scripts and styles", () => {
        expect(htmlToMarkdown("<p>One</p><script>x()</script><style>p{}</style><p>Two &amp; <b>three</b></p>"))
            .toBe("One\n\nTwo & **three**");
    });
});
