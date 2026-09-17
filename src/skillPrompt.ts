// The coach's entire behavior is the tbp-coach skill file at skill/SKILL.md.
// Source of truth: https://github.com/artsmalley/skills (skills/tbp-coach/SKILL.md).
// To update the coach, replace skill/SKILL.md with the new version and redeploy.
// To rename or localize the coach, edit skill/SKILL.md — not this file.
import * as fs from "fs";
import * as path from "path";

function locateSkillFile(): string {
  // Compiled: lib/src/skillPrompt.js -> ../../skill/SKILL.md
  // ts-node dev: src/skillPrompt.ts -> ../skill/SKILL.md
  const candidates = [
    path.resolve(__dirname, "..", "..", "skill", "SKILL.md"),
    path.resolve(__dirname, "..", "skill", "SKILL.md"),
    path.resolve(process.cwd(), "skill", "SKILL.md"),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `skill/SKILL.md not found. Looked in:\n  ${candidates.join("\n  ")}`
    );
  }
  return found;
}

function stripFrontmatter(md: string): string {
  // YAML frontmatter (name/description/metadata) is for skill installers, not the model.
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return m ? md.slice(m[0].length) : md;
}

const skillPath = locateSkillFile();
export const SKILL_MD: string = stripFrontmatter(fs.readFileSync(skillPath, "utf8"));
console.log(`[skill] loaded ${skillPath} (${SKILL_MD.length} chars)`);
