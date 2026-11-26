// Email (.eml) uploads become a Markdown document: a header block (From, To,
// Cc, Date as sent, Subject), the body as Markdown, and a list of the
// attachments with what became of each. Attachments of a type Mike accepts
// are handed back as bytes so the caller can store each one as a document of
// its own next to the email. This module depends only on postal-mime and
// node-html-markdown; the caller does all storage.
//
// The message is untrusted. Markdown is plain text, so nothing in it is
// fetched; HTML bodies lose scripts, styles and head content, and images are
// reduced to their alt text so no remote (or cid:) reference survives.

import PostalMime from "postal-mime";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { ALLOWED_DOCUMENT_TYPES, documentSuffix, isTextDocumentType } from "./documentTypes";

type Address = PostalMime.Address;
type Attachment = PostalMime.Attachment;

/** Attachments imported per uploaded email, nested emails included: bounds the work one upload causes. */
export const MAX_EMAIL_ATTACHMENTS = 25;
/** Decoded attachment bytes imported per uploaded email, nested emails included. */
export const MAX_EMAIL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** How deep emails attached to emails are imported; the uploaded email is depth 0. */
export const MAX_EMAIL_NESTING_DEPTH = 3;
/** Longest filename given to a derived document. */
const MAX_FILENAME_LENGTH = 255;

/** What is left to spend on one uploaded email and everything nested in it. */
export type EmailImportBudget = { attachments: number; bytes: number };

export function newEmailImportBudget(): EmailImportBudget {
  return { attachments: MAX_EMAIL_ATTACHMENTS, bytes: MAX_EMAIL_ATTACHMENT_BYTES };
}

/** An attachment to store as its own document. `fileType` "eml" is an email to convert the same way. */
export type EmailAttachmentDocument = {
  filename: string;
  fileType: string;
  content: Uint8Array;
};

export type EmailMarkdown = {
  markdown: string;
  attachments: EmailAttachmentDocument[];
};

export type EmailMarkdownOptions = {
  /** The email's file name; attachment documents are named "<emailFilename> - <attachment>". */
  emailFilename: string;
  /** Shared across one upload and every email nested in it; spent by this call. */
  budget: EmailImportBudget;
  /** 0 for the uploaded email, one more for each level of nesting. */
  depth?: number;
};

/** The Markdown document an email becomes: "Contract.eml" -> "Contract.eml.md". */
export function emailDocumentFilename(emailFilename: string): string {
  return clampFilename(`${emailFilename}.md`);
}

function formatAddress(address: Address): string {
  if (address.group) {
    const members = address.group.map(formatAddress).join(", ");
    return `${address.name}: ${members};`;
  }
  const mailbox = address.address ?? "";
  return address.name ? `${address.name} <${mailbox}>` : mailbox;
}

function formatAddresses(addresses: Address[] | Address | undefined): string {
  if (!addresses) return "";
  const list = Array.isArray(addresses) ? addresses : [addresses];
  return list.map(formatAddress).join(", ");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

/** A value placed inline in Markdown must not open markup of its own. */
function escapeInline(value: string): string {
  return value.replace(/[\\`*[\]<>|]/g, (character) => `\\${character}`);
}

const htmlConverter = new NodeHtmlMarkdown(
  { bulletMarker: "-", maxConsecutiveNewlines: 2 },
  {
    // Never reference an image: a remote one would be fetched by whatever
    // renders the Markdown, and a cid: one points nowhere. Keep the alt text.
    img: ({ node }) => {
      const alt = node.getAttribute("alt")?.trim() ?? "";
      const content = alt ? `[image: ${escapeInline(alt)}]` : "";
      return { content, recurse: false };
    },
    // Forms and embedded content carry nothing to read.
    "form,iframe,object,embed,video,audio,canvas,svg,template": { ignore: true },
  },
);

/**
 * Markdown from an HTML body: headings, lists, tables, links (text and URL),
 * bold/italic and quoted replies as `>` blocks. Scripts, styles and head
 * content are dropped and images become their alt text.
 */
export function htmlToMarkdown(html: string): string {
  return htmlConverter.translate(html).trim();
}

/**
 * The plain-text body as Markdown: paragraphs stay paragraphs, line breaks
 * stay line breaks, and "> " quoted replies become quote blocks. Only lines
 * that would turn into headings or rules are escaped.
 */
function plainTextToMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n[ \t]*\n/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.replace(/^(\s*)(#|=+\s*$|-{3,}\s*$|_{3,}\s*$)/, "$1\\$2"))
        .join("  \n"),
    )
    .join("\n\n");
}

/** A filename safe to show and store: no path, no control characters. */
function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "_").trim();
}

function clampFilename(name: string): string {
  if (name.length <= MAX_FILENAME_LENGTH) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  const stem = name.slice(0, MAX_FILENAME_LENGTH - extension.length);
  return `${stem}${extension}`;
}

/** The attachment's document type, from its name or else its MIME type; "" when unknown. */
function attachmentType(attachment: Attachment, filename: string): string {
  const suffix = documentSuffix(filename);
  if (suffix) return suffix;
  if (attachment.mimeType === "message/rfc822") return "eml";
  if (attachment.mimeType === "application/pdf") return "pdf";
  return "";
}

/**
 * Types an attachment is imported as. HTML is left out: it would be stored
 * as raw markup, which serves nobody reading it as a document.
 */
function isImportableType(fileType: string): boolean {
  if (fileType === "html") return false;
  return ALLOWED_DOCUMENT_TYPES.has(fileType) || isTextDocumentType(fileType);
}

function attachmentBytes(content: Attachment["content"]): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/**
 * Render a raw RFC 822 message as Markdown and pick the attachments to import
 * as documents. Spends `options.budget`; an attachment with an unsupported
 * type, nested too deeply or over the budget is listed but not returned.
 * Throws when the message cannot be parsed.
 */
export async function emailToMarkdown(
  raw: Uint8Array | ArrayBuffer,
  options: EmailMarkdownOptions,
): Promise<EmailMarkdown> {
  const depth = options.depth ?? 0;
  const email = await PostalMime.parse(raw);
  // The Date header as the sender wrote it (with its zone), not re-formatted.
  const rawDate = email.headers.find((header) => header.key === "date")?.value;
  const subject = email.subject ?? "";
  const headerRows: Array<[string, string]> = [
    ["From", formatAddresses(email.from)],
    ["To", formatAddresses(email.to)],
    ["Cc", formatAddresses(email.cc)],
    ["Date", rawDate ?? email.date ?? ""],
    ["Subject", subject],
  ];
  const headers = headerRows
    .filter(([, value]) => value)
    .map(([label, value]) => {
      const shown = escapeInline(value);
      return `**${label}:** ${shown}`;
    })
    .join("  \n");

  const plain = email.text?.trim();
  const body = plain ? plainTextToMarkdown(plain) : htmlToMarkdown(email.html ?? "");

  const imported: EmailAttachmentDocument[] = [];
  const listed: string[] = [];
  for (const attachment of email.attachments) {
    // A part the HTML body shows by its Content-ID belongs to the body.
    if (attachment.related) continue;
    const named = cleanFilename(attachment.filename ?? "");
    const shownName = escapeInline(named || `unnamed ${attachment.mimeType}`);
    const content = attachmentBytes(attachment.content);
    const size = formatSize(content.byteLength);
    const fileType = attachmentType(attachment, named);

    let outcome: string;
    if (!isImportableType(fileType)) {
      outcome = "not imported: unsupported type";
    } else if (fileType === "eml" && depth >= MAX_EMAIL_NESTING_DEPTH) {
      outcome = "not imported: emails nested too deeply";
    } else if (options.budget.attachments < 1 || content.byteLength > options.budget.bytes) {
      outcome = "not imported: over limit";
    } else {
      options.budget.attachments -= 1;
      options.budget.bytes -= content.byteLength;
      const baseName = named || "attachment";
      const extension = documentSuffix(baseName) === fileType ? "" : `.${fileType}`;
      const filename = clampFilename(`${options.emailFilename} - ${baseName}${extension}`);
      imported.push({ filename, fileType, content });
      const documentName = fileType === "eml" ? emailDocumentFilename(filename) : filename;
      const shownDocument = escapeInline(documentName);
      outcome = `imported as document "${shownDocument}"`;
    }
    listed.push(`- ${shownName} (${size}): ${outcome}`);
  }

  const title = escapeInline(subject || "Email");
  const sections = [`# ${title}`, headers, "---", body || "_(no message body)_"];
  if (listed.length) {
    const count = listed.length;
    const list = listed.join("\n");
    sections.push("---", `**Attachments (${count}):**`, list);
  }
  const content = sections.join("\n\n");
  return { markdown: `${content}\n`, attachments: imported };
}
