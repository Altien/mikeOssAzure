// Dev's frontend is a static Next export bundled into the Azure backend.
// Production typechecking excludes test-only imports into sibling workspaces;
// the full CI typecheck still covers those tests. These rules ensure the
// production build does not silently drop application code.
//
// Upstream (a1c87117) ties rules 1 and 2 to `frontend/Dockerfile`. Dev builds
// the export in the root `Dockerfile` (frontend-builder stage), which copies
// the shared packages to /app/packages/<name> beside /app/frontend; these
// rules read that stage's `COPY packages/<name> /app/packages/<name>` lines.
//
// Rule 4 (upstream f9a79d69): no `paths` alias targets a declaration file
// unless every import of it is type-only. Turbopack resolves runtime imports
// through these aliases too, and a `.d.ts` has no runtime exports: a
// `react/jsx-runtime` alias to @types once compiled every JSX call to
// `(void 0)(...)`, and the built app rendered only its error page.
//
// Rule 5 (upstream 821c0131): the shared packages keep the boundary their
// READMEs state: a package's relative imports stay inside it; `@mike/client`
// is framework-free and never imports `@mike/ui` or an application; `@mike/ui`
// imports only `@mike/client` and its declared peer dependencies; and
// application code reaches a package only through its bare name.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const FRONTEND = resolve(__dirname, "../..");
const REPO = resolve(FRONTEND, "..");

const toPosix = (p: string) => p.split(sep).join("/");
const relToFrontend = (file: string) => toPosix(relative(FRONTEND, file));

function isInside(dir: string, file: string): boolean {
    const rel = relative(dir, file);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function loadProgram(configName: string): ts.ParsedCommandLine {
    const configPath = join(FRONTEND, configName);
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(read.error, `${configName} must parse`).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, FRONTEND);
    expect(parsed.fileNames.length, `${configName} must include files`).toBeGreaterThan(0);
    return parsed;
}

/**
 * The shared package directories the root Dockerfile's frontend-builder stage
 * copies to the same repository-relative path under /app (so `../packages/x`
 * from /app/frontend resolves in the image exactly as it does on disk).
 */
function dockerCopiedPackageDirs(): string[] {
    const dockerfile = readFileSync(join(REPO, "Dockerfile"), "utf8");
    const stage = dockerfile.split(/^FROM /m).find((s) => /AS frontend-builder/.test(s)) ?? "";
    const dirs: string[] = [];
    for (const match of stage.matchAll(/^COPY\s+(packages\/[^\s]+?)\/?\s+\/app\/(packages\/[^\s]+?)\/?\s*$/gm)) {
        if (match[1] === match[2]) dirs.push(resolve(REPO, match[1]));
    }
    return dirs;
}

const IMPORT_RE =
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importSpecifiers(file: string): string[] {
    const source = readFileSync(file, "utf8");
    const out: string[] = [];
    for (const match of source.matchAll(IMPORT_RE)) {
        out.push(match[1] ?? match[2]);
    }
    return out;
}

const isTestOnly = (rel: string) =>
    /\.(test|spec)\.tsx?$/.test(rel) ||
    /(^|\/)__tests__\//.test(rel) ||
    rel === "vitest.config.mts" ||
    rel === "vitest.setup.ts";

describe("frontend build boundaries", () => {
    const build = loadProgram("tsconfig.build.json");
    const full = loadProgram("tsconfig.json");
    const copiedDirs = dockerCopiedPackageDirs();

    it("rule 1: every relative import in the production build program stays inside the image", () => {
        // A package directory the Dockerfile copies whole keeps its internal
        // layout, so a relative import between two files under the same copied
        // directory resolves in the image too.
        const sameCopiedDir = (file: string, target: string) =>
            copiedDirs.some((dir) => isInside(dir, file) && isInside(dir, target));
        const violations: string[] = [];
        for (const file of build.fileNames) {
            for (const spec of importSpecifiers(file)) {
                if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
                const target = resolve(dirname(file), spec);
                if (!isInside(FRONTEND, target) && !sameCopiedDir(file, target)) {
                    violations.push(`${relToFrontend(file)} -> ${spec}`);
                }
            }
        }
        expect(
            violations,
            "A production source file reaches outside frontend/ (and outside the " +
                "shared package it lives in) by relative import. Use an explicit " +
                "workspace alias whose target the root Dockerfile copies, or name " +
                "test-only files so tsconfig.build.json excludes them.",
        ).toEqual([]);
    });

    it("rule 2: every tsconfig alias that leaves frontend/ targets a package the Dockerfile copies", () => {
        const paths = build.options.paths ?? {};
        const base = build.options.baseUrl ?? FRONTEND;
        const missing: string[] = [];
        for (const [alias, targets] of Object.entries(paths)) {
            for (const target of targets) {
                const abs = resolve(base, target);
                if (isInside(FRONTEND, abs)) continue;
                if (!copiedDirs.some((dir) => isInside(dir, abs))) {
                    missing.push(`${alias} -> ${target}`);
                }
            }
        }
        expect(
            missing,
            "A tsconfig `paths` alias points outside frontend/ but the root Dockerfile's " +
                "frontend-builder stage does not COPY its package to /app/packages/<name>.",
        ).toEqual([]);
    });

    it("rule 3: the build program excludes test-only files and nothing else", () => {
        const inBuild = new Set(build.fileNames);
        const dropped = full.fileNames
            .filter((f) => !inBuild.has(f))
            .map(relToFrontend)
            .filter((rel) => !isTestOnly(rel));
        expect(
            dropped,
            "tsconfig.build.json excludes a file that is not test-only, so `next build` " +
                "no longer type-checks it.",
        ).toEqual([]);

        const testsInBuild = build.fileNames.map(relToFrontend).filter(isTestOnly);
        expect(testsInBuild, "tsconfig.build.json must exclude every test-only file").toEqual([]);
    });

    it("rule 4: no tsconfig alias a runtime import can reach targets a declaration file", () => {
        // @mike/contracts is declarations only and is imported with `import type`
        // (AGENTS.md), which the bundler erases before resolving anything.
        const TYPE_ONLY_ALIASES = new Set(["@mike/contracts"]);
        const paths = build.options.paths ?? {};
        const declarationTargets = Object.entries(paths)
            .filter(([alias]) => !TYPE_ONLY_ALIASES.has(alias))
            .flatMap(([alias, targets]) =>
                targets.filter((t) => /\.d\.[cm]?ts$/.test(t)).map((t) => `${alias} -> ${t}`),
            );
        expect(
            declarationTargets,
            "A tsconfig `paths` alias maps a module to a declaration file. Turbopack " +
                "applies these aliases to runtime imports, so the bundle gets a module " +
                "with no exports. Point it at the runtime package (types come from " +
                "`typeRoots`), or drop it.",
        ).toEqual([]);
    });

    it("rule 5: the shared packages keep their stated import boundary", () => {
        const PACKAGES = resolve(REPO, "packages");
        const WORD_ADDIN = resolve(REPO, "word-addin");
        const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { peerDependencies?: Record<string, string> };
        // What each package may import by bare name: its declared peers (the
        // consuming app supplies them) plus Node built-ins; `@mike/client` may
        // reach React for types only.
        const allowed: Record<string, Set<string>> = {
            client: new Set(Object.keys(readJson(join(PACKAGES, "client/package.json")).peerDependencies ?? {})),
            ui: new Set(Object.keys(readJson(join(PACKAGES, "ui/package.json")).peerDependencies ?? {})),
        };
        allowed.client.add("react");
        const bareName = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
        const violations: string[] = [];
        for (const file of full.fileNames) {
            const rel = toPosix(relative(REPO, file));
            if (isTestOnly(relToFrontend(file)) || /\.stories\.tsx?$/.test(rel)) continue;
            const pkg = /^packages\/(ui|client)\//.exec(rel)?.[1];
            const source = readFileSync(file, "utf8");
            for (const spec of importSpecifiers(file)) {
                if (pkg) {
                    if (spec.startsWith(".")) {
                        if (!isInside(join(PACKAGES, pkg), resolve(dirname(file), spec)))
                            violations.push(`${rel} -> ${spec} (leaves packages/${pkg})`);
                        continue;
                    }
                    if (spec.startsWith("node:")) continue;
                    const name = bareName(spec);
                    if (name === "@mike/client" && pkg === "client")
                        violations.push(`${rel} -> ${spec} (a package does not import its own barrel)`);
                    else if (name === "@mike/ui")
                        violations.push(`${rel} -> ${spec} (${pkg === "client" ? "@mike/client never imports @mike/ui" : "a package does not import its own barrel"})`);
                    else if (!allowed[pkg].has(name))
                        violations.push(`${rel} -> ${spec} (not a declared peer dependency of @mike/${pkg})`);
                    else if (pkg === "client" && name === "react" && !new RegExp(`import\\s+type\\s[^;]*from\\s+["']${spec}["']`).test(source))
                        violations.push(`${rel} -> ${spec} (@mike/client is framework-free: React for types only)`);
                } else {
                    // Application code: packages by bare name only.
                    const target = spec.startsWith(".") ? resolve(dirname(file), spec) : null;
                    if (/^@mike\/(ui|client)\//.test(spec) || (target && isInside(PACKAGES, target) && !isInside(WORD_ADDIN, target)))
                        violations.push(`${rel} -> ${spec} (import @mike/ui or @mike/client by name, not a file inside it)`);
                }
            }
        }
        expect(
            violations,
            "packages/ui/README.md and packages/client/README.md state these rules; " +
                "an import crossed the boundary they describe.",
        ).toEqual([]);
    });
});
