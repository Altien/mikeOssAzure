import { createHash } from "node:crypto";
import path from "node:path";

export type AdaptationFile = {
  path: string;
  bytes: Uint8Array;
  inspectionClass: "text" | "source" | "binary" | "nested_archive";
};

export type AdaptationChange = {
  oldPath: string;
  newPath: string;
  oldHash: string;
  newHash: string;
  kind: "content" | "path" | "content_and_path";
};

function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalSkillName(value: string) {
  const name = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!name) throw new Error("A valid skill name is required.");
  return name;
}

function replaceExactIdentifier(text: string, oldName: string, newName: string) {
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "g"),
    newName,
  );
}

export function planSkillRename(args: {
  files: AdaptationFile[];
  entrypointPath: string;
  oldDisplayName: string;
  oldCanonicalName: string;
  newDisplayName: string;
}) {
  const newCanonicalName = canonicalSkillName(args.newDisplayName);
  const pathMap = new Map<string, string>();
  for (const file of args.files) {
    const segments = file.path.split("/");
    const next = segments
      .map((segment) =>
        segment === args.oldCanonicalName ? newCanonicalName : segment,
      )
      .join("/");
    pathMap.set(file.path, next);
  }

  const adaptedFiles = args.files.map((file) => {
    const newPath = pathMap.get(file.path)!;
    let bytes = file.bytes;
    if (
      file.inspectionClass === "text" ||
      file.inspectionClass === "source"
    ) {
      let text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      if (file.path === args.entrypointPath) {
        text = text.replace(
          /^(\s*name\s*:\s*)(?:"[^"]*"|'[^']*'|[^\r\n]*)/m,
          `$1${args.newDisplayName}`,
        );
      }
      text = replaceExactIdentifier(
        text,
        args.oldCanonicalName,
        newCanonicalName,
      );
      for (const [oldPath, replacementPath] of pathMap) {
        if (oldPath !== replacementPath) {
          text = text.split(oldPath).join(replacementPath);
        }
      }
      bytes = new TextEncoder().encode(text);
    }
    return {
      path: newPath,
      bytes,
      inspectionClass: file.inspectionClass,
      originalPath: file.path,
    };
  });
  const collisions = new Set<string>();
  for (const file of adaptedFiles) {
    const key = file.path.normalize("NFC").toLocaleLowerCase();
    if (collisions.has(key)) {
      throw new Error(`Rename creates a path collision at '${file.path}'.`);
    }
    collisions.add(key);
  }
  const changes: AdaptationChange[] = [];
  for (const file of adaptedFiles) {
    const original = args.files.find((item) => item.path === file.originalPath)!;
    const oldHash = sha(original.bytes);
    const newHash = sha(file.bytes);
    const contentChanged = oldHash !== newHash;
    const pathChanged = file.originalPath !== file.path;
    if (contentChanged || pathChanged) {
      changes.push({
        oldPath: file.originalPath,
        newPath: file.path,
        oldHash,
        newHash,
        kind:
          contentChanged && pathChanged
            ? "content_and_path"
            : contentChanged
              ? "content"
              : "path",
      });
    }
  }
  const treeHash = createHash("sha256")
    .update(
      adaptedFiles
        .map((file) => `${file.path}\0${sha(file.bytes)}\0${file.bytes.length}`)
        .sort()
        .join("\n"),
    )
    .digest("hex");
  return {
    newDisplayName: args.newDisplayName.trim(),
    newCanonicalName,
    newEntrypointPath:
      pathMap.get(args.entrypointPath) ?? path.posix.normalize(args.entrypointPath),
    files: adaptedFiles,
    changes,
    treeHash,
  };
}
