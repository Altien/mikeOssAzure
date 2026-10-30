// The product version lives in one place, /VERSION, and everything that names
// a release derives from it (mike@<version>+<sha12>). See docs/observability.md.
//
// Upstream divergence (sync-log: 3bcac35a): upstream also checks its GHCR
// publish-images workflow, the compose image tags and the deployment docs'
// MIKE_IMAGE_TAG pin. Dev releases through its own ACR/marketplace pipeline
// (deploy.ps1, scripts/release-images.sh, VERSIONS.md), so those checks are
// not carried; what remains is the shape of VERSION and that Dev's image
// builds pass it through as MIKE_VERSION.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

// Semver core with an optional prerelease; the commit is the build metadata,
// never part of VERSION (frontend/src/shared/lib/releaseName.cjs).
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe("product version", () => {
    const version = read("VERSION").trim();

    it("is a semver string without build metadata", () => {
        expect(version).toMatch(SEMVER);
        expect(read("VERSION").replace(/\r\n/g, "\n")).toBe(`${version}\n`);
    });
});
