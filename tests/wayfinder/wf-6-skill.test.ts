// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-6 (#639), supporting checklist: "The skill is the upstream one, pinned by
// digest, reaching the map only through the tracker operations." No database:
// the pin is the vendored folder against `skills-lock.json`, by the `skills`
// CLI's own digest (`skill-digest.ts`), and the route is the Ops Astro tracker
// file (API-5), whose every call API-5's contract suite runs through the verb
// CLI to its owning command. The sidebar agent that runs the skill is held
// (`wf-6-held.test.ts`).

import { cpSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliCalls, operations, read, ROOT, section, TRACKER_FILE } from '../cli/api-5-tracker.ts';
import { skillFolderHash } from './skill-digest.ts';

const SKILL = '.claude/skills/wayfinder';

/** A code span that runs something: any route to the map other than the verb CLI. */
const PROGRAM = /^(?:gh|git|curl|wget|psql|node|npx|pnpm|npm|yarn|sh|bash|zsh|sql)(?:\s|$)/iu;

interface LockEntry {
  readonly source: string;
  readonly sourceType: string;
  readonly skillPath: string;
  readonly computedHash: string;
}

const LOCK = (JSON.parse(read('skills-lock.json')) as { skills: Record<string, LockEntry> }).skills;

const scratch: string[] = [];
afterEach(() => {
  for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A copy of the vendored skill to break, in a folder of its own. */
function copyOfSkill(): string {
  const folder = mkdtempSync(join(tmpdir(), 'wf6-skill-'));
  scratch.push(folder);
  const copy = join(folder, 'wayfinder');
  cpSync(join(ROOT, SKILL), copy, { recursive: true });
  return copy;
}

describe('WF-6 the skill is the upstream one, pinned by digest, reaching the map only through the tracker operations', () => {
  it('pins the upstream wayfinder skill, and the vendored folder has its digest', () => {
    expect(LOCK['wayfinder']).toMatchObject({
      source: 'mattpocock/skills',
      sourceType: 'github',
      skillPath: 'skills/engineering/wayfinder/SKILL.md',
    });
    expect(skillFolderHash(join(ROOT, SKILL))).toBe(LOCK['wayfinder']?.computedHash);
  });

  it('holds the digest to every byte, name and file of the folder', () => {
    const pinned = LOCK['wayfinder']?.computedHash;
    const edited = copyOfSkill();
    expect(skillFolderHash(edited)).toBe(pinned);
    writeFileSync(join(edited, 'SKILL.md'), `${read(`${SKILL}/SKILL.md`)} `);
    expect(skillFolderHash(edited), 'one byte added').not.toBe(pinned);

    const renamed = copyOfSkill();
    renameSync(join(renamed, 'agents'), join(renamed, 'agent'));
    expect(skillFolderHash(renamed), 'a folder renamed').not.toBe(pinned);

    const added = copyOfSkill();
    writeFileSync(join(added, 'NOTES.md'), '');
    expect(skillFolderHash(added), 'an empty file added').not.toBe(pinned);
  });

  it('sends the skill to the tracker doc for every map operation, and the doc answers each with the CLI alone', () => {
    const skill = read(`${SKILL}/SKILL.md`);
    expect(skill).toContain('Consult the tracker doc\'s "Wayfinding operations" section');
    const wayfinding = operations(section(read(TRACKER_FILE), 'Wayfinding operations'));
    // Upstream's six, each with its Ops Astro line; the file adds its own after them.
    expect(wayfinding.map((operation) => operation.label).slice(0, 6)).toStrictEqual([
      'Map',
      'Child ticket',
      'Blocking',
      'Frontier query',
      'Claim',
      'Resolve',
    ]);
    for (const { label, text } of wayfinding) {
      expect(cliCalls(text).length, label).toBeGreaterThan(0);
      // Nothing else a line could run: a span naming a program is the verb CLI.
      const spans = [...text.matchAll(/`([^`]+)`/gu)].map((match) => match[1] as string);
      const programs = spans.filter((span) => PROGRAM.test(span.trimStart()));
      for (const program of programs) expect(program, label).toMatch(/^pnpm cli /u);
    }
  });
});
