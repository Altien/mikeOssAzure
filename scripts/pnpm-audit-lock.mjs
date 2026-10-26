import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const record = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be a mapping");
  return value;
};

/** Parse the audited standalone pnpm project, never an installed/hoisted tree. */
export function loadPnpmAuditGraph(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (!/^pnpm@\d+\.\d+\.\d+(?:\+.*)?$/.test(manifest.packageManager ?? "")) {
    throw new Error("The audited project must declare its exact pnpm packageManager");
  }
  if ((manifest.dependencies?.yaml ?? manifest.devDependencies?.yaml) !== "2.9.1") {
    throw new Error("Audit parser requires a direct yaml@2.9.1 dependency in the audited project");
  }
  const require = createRequire(join(directory, "package.json"));
  const yaml = require("yaml");
  const document = yaml.parseDocument(readFileSync(join(directory, "pnpm-lock.yaml"), "utf8"), { uniqueKeys: true });
  if (document.errors.length) throw new Error("Invalid pnpm-lock.yaml: " + document.errors[0].message);
  return buildPnpmAuditGraph(document.toJS({ maxAliasCount: 0 }));
}

/** pnpm v9 lockfiles keep package identity apart from peer-context snapshots. */
export function buildPnpmAuditGraph(raw) {
  const lock = record(raw, "lockfile");
  if (String(lock.lockfileVersion) !== "9.0") throw new Error("Unsupported pnpm lockfileVersion; expected 9.0");
  const metadata = record(lock.packages, "packages");
  const snapshots = record(lock.snapshots, "snapshots");
  const importers = record(lock.importers, "importers");
  if (!Object.keys(snapshots).length || !Object.keys(importers).length) throw new Error("pnpm lockfile has no resolved graph/importers; refusing an empty audit");
  const nodes = new Map();
  const dependents = new Map();
  const adjacency = new Map();
  const roots = [];
  for (const [id, rawSnapshot] of Object.entries(snapshots)) {
    const snapshot = record(rawSnapshot, "snapshot " + id);
    const base = id.split("(", 1)[0];
    const split = base.indexOf("@", base.startsWith("@") ? 1 : 0);
    if (split < 1) throw new Error("Unrecognised pnpm package identity: " + id);
    const name = base.slice(0, split), reference = base.slice(split + 1);
    const meta = record(metadata[base], "metadata for " + id);
    const version = meta.version ?? reference;
    if (typeof version !== "string" || !exactVersion.test(version)) throw new Error("No exact npm version for " + id);
    nodes.set(id, { name, version, path: "snapshots/" + id, snapshot, prod: false, dev: false });
    adjacency.set(id, []);
    dependents.set("snapshots/" + id, new Set());
  }
  function resolve(alias, entry, parent) {
    const reference = typeof entry === "string" ? entry : record(entry, "dependency " + alias).version;
    if (typeof reference !== "string" || !reference) throw new Error("No resolved reference for " + parent + " -> " + alias);
    const ref = reference.startsWith("npm:") ? reference.slice(4) : reference;
    const candidates = [...new Set([ref, alias + "@" + ref])].filter(id => nodes.has(id));
    if (candidates.length !== 1) throw new Error("Unresolved/ambiguous pnpm edge " + parent + " -> " + alias + " (" + reference + ")");
    return candidates[0];
  }
  function edges(parentPath, owner, groups, importer = false) {
    for (const group of groups) {
      if (owner[group] === undefined) continue;
      for (const [alias, entry] of Object.entries(record(owner[group], parentPath + "/" + group))) {
        const target = resolve(alias, entry, parentPath);
        const edge = parentPath + "#" + group + ":" + alias;
        dependents.get(nodes.get(target).path).add(edge);
        if (importer) roots.push({ target, mode: group === "devDependencies" ? "dev" : "prod" });
        else adjacency.get(parentPath.slice("snapshots/".length)).push(target);
      }
    }
  }
  for (const [id, node] of nodes) {
    edges(node.path, node.snapshot, ["dependencies", "optionalDependencies"]);
    const meta = metadata[id.split("(", 1)[0]];
    for (const peer of Object.keys(meta.peerDependencies ?? {})) {
      if (Object.hasOwn(node.snapshot.dependencies ?? {}, peer) || Object.hasOwn(node.snapshot.optionalDependencies ?? {}, peer)) continue;
      if (id.includes("(" + peer + "@")) throw new Error("Missing resolved peer edge " + id + " -> " + peer);
    }
  }
  for (const [id, importer] of Object.entries(importers)) {
    if (id.startsWith("/") || id.split("/").includes("..")) throw new Error("Importer escapes audited project: " + id);
    edges("importers/" + id, record(importer, "importer " + id), ["dependencies", "optionalDependencies", "devDependencies"], true);
  }
  if (!roots.length) throw new Error("pnpm importers declare no resolved dependencies; refusing an empty audit");
  const pending = [...roots];
  for (let index = 0; index < pending.length; index++) {
    const { target, mode } = pending[index], node = nodes.get(target);
    if (node[mode]) continue;
    node[mode] = true;
    for (const child of adjacency.get(target)) pending.push({ target: child, mode });
  }
  const packages = Object.create(null);
  const installations = [];
  for (const node of nodes.values()) {
    (packages[node.name] ??= []);
    if (!packages[node.name].includes(node.version)) packages[node.name].push(node.version);
    installations.push({ name: node.name, version: node.version, path: node.path, dev: node.dev && !node.prod });
  }
  return { packages, installations, dependents };
}

export function validateScopedAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) throw new Error("Audit allowlist must be an array");
  const ids = new Set();
  for (const entry of allowlist) {
    if (!/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(entry?.ghsa ?? "") || ids.has(entry.ghsa) ||
        typeof entry.reason !== "string" || !entry.reason.trim() || !Array.isArray(entry.scopes) || !entry.scopes.length ||
        !entry.scopes.every(scope => typeof scope.workspace === "string" && typeof scope.package === "string" &&
          typeof scope.version === "string" && exactVersion.test(scope.version) &&
          typeof scope.path === "string" && scope.path.startsWith("snapshots/") && scope.dev === true &&
          Array.isArray(scope.dependents) && scope.dependents.length && scope.dependents.every(parent =>
            typeof parent === "string" && /^(?:snapshots|importers)\/.+#(?:dependencies|optionalDependencies|devDependencies):.+$/.test(parent)))) {
      throw new Error("Invalid pnpm-scoped audit exception: " + (entry?.ghsa ?? "unknown"));
    }
    ids.add(entry.ghsa);
  }
}

export function isAllowedPnpm(exception, matches, graph, workspace) {
  return Boolean(exception && matches.length && matches.every(match => {
    const copies = graph.installations.filter(copy => copy.name === match.name && copy.version === match.version);
    return copies.length && copies.every(copy => {
      const parents = [...(graph.dependents.get(copy.path) ?? [])];
      return copy.dev && parents.length && exception.scopes.some(scope => {
        const permitted = new Set(scope.dependents);
        return scope.workspace === workspace && scope.package === copy.name && scope.version === copy.version &&
          scope.path === copy.path && scope.dev === true && parents.length === permitted.size &&
          parents.every(parent => permitted.has(parent));
      });
    });
  }));
}
