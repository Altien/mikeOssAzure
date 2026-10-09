import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateSkillZip } from "../../backend/src/altien/skills/archive";

const dir = join(__dirname, "out");

async function main() {
  for (const name of (await readdir(dir)).sort()) {
    const bytes = await readFile(join(dir, name));
    try {
      const result = await validateSkillZip(bytes);
      const skills = result.skills
        .map((s) => `${s.declaredName} v${s.declaredVersion ?? "-"} @ ${s.entrypointPath}`)
        .join("; ");
      console.log(
        `ACCEPT  ${name.padEnd(30)} ${result.files.length} files | ${skills}`,
      );
    } catch (error) {
      const code = (error as { code?: string }).code ?? "?";
      console.log(
        `REJECT  ${name.padEnd(30)} [${code}] ${(error as Error).message}`,
      );
    }
  }
}

void main();
