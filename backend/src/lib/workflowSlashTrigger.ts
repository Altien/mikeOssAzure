const SLASH_TRIGGER_PATTERN = /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseScalar(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function normalizeWorkflowSlashTrigger(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return SLASH_TRIGGER_PATTERN.test(trimmed) ? trimmed : null;
}

export function workflowSlashTriggerFromSkillMd(
  skillMd: unknown,
): string | null {
  if (typeof skillMd !== "string") return null;

  const frontmatter = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return null;

  const lines = frontmatter[1].split(/\r?\n/);
  const metadataIndex = lines.findIndex((line) => /^metadata:\s*$/.test(line));
  if (metadataIndex === -1) return null;

  for (let index = metadataIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !/^\s/.test(line)) break;

    const match = line.match(/^\s{2}mike-slash-trigger:\s*(.*?)\s*$/);
    if (!match) continue;
    return normalizeWorkflowSlashTrigger(parseScalar(match[1]));
  }

  return null;
}
