// SPDX-License-Identifier: AGPL-3.0-only
//
// The digest `skills-lock.json` pins a vendored skill by: the `skills` CLI's
// folder hash (vercel-labs/skills, `computeSkillFolderHash`). Every file
// under the skill's folder, `.git` and `node_modules` skipped, sorted by its
// `/`-separated relative path with `localeCompare`, and one SHA-256 over each
// file's path followed by its bytes. `localeCompare` is why `agents/…` sorts
// before `SKILL.md`; a byte-order sort gives another digest.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

function filesUnder(base: string, at: string): readonly string[] {
  return readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
    const full = join(at, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '.git' || entry.name === 'node_modules' ? [] : filesUnder(base, full);
    }
    return entry.isFile() ? [relative(base, full).split(sep).join('/')] : [];
  });
}

/** The folder's digest, as the `skills` CLI computes `computedHash`. */
export function skillFolderHash(folder: string): string {
  const hash = createHash('sha256');
  const files = [...filesUnder(folder, folder)].toSorted((a, b) => a.localeCompare(b));
  for (const file of files) {
    hash.update(file);
    hash.update(readFileSync(join(folder, file)));
  }
  return hash.digest('hex');
}
