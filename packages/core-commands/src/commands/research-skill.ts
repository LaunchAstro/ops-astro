// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7: a research run follows the upstream research skill, unmodified, and
// pins it by digest on the run's pinned-versions record (ORCH47 ruling (b)8):
// the run's definition reference slot (AW-02, 0192), which MP-6-2's task read
// shows as the run's `pins`. The entry is the skill's SKILL.md and the
// manifest is every file of its folder, so a read of the skill during the run
// is the pinned read (`readPinned`).
//
// Unmodified means the folder's digest is the one `skills-lock.json` records
// for it: the `skills` CLI's folder hash (one SHA-256 over each file's
// `/`-separated path and then its bytes, the paths sorted with
// `localeCompare`). It is written here in code, so a changed lock is a
// reviewed change; any other folder is refused before anything is pinned.

import { createHash } from 'node:crypto';
import {
  captureManifest,
  pinBootstrapFile,
  refuse,
  type AdmittedActivation,
  type FileIdentity,
  type InstructionSource,
  type RuntimeResult,
} from '../../../core-runtime/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';

/** The vendored skill: its folder in the repository, its entry file, and its locked digest. */
export const RESEARCH_SKILL: {
  readonly folder: string;
  readonly entry: string;
  readonly digest: string;
} = {
  folder: '.claude/skills/research',
  entry: 'SKILL.md',
  digest: 'c8c1cba327a6f824b554cd978079a3dadd7406d73174f8fb9bfef58824691970',
};

/**
 * Pins the research skill on the run: every file of the folder read from
 * `source` (paths relative to the folder), the folder's digest checked
 * against the lock, then the entry pinned with the manifest beside it.
 */
export async function pinResearchSkill(
  tx: TenantQuery,
  activation: AdmittedActivation,
  pin: {
    readonly runId: string;
    readonly source: InstructionSource;
    readonly files: readonly string[];
  },
): Promise<RuntimeResult<FileIdentity>> {
  const manifest = await captureManifest(pin.source, pin.files);
  if (!manifest.ok) return manifest;
  if ((await folderDigest(pin.source, pin.files)) !== RESEARCH_SKILL.digest) {
    return refuse(
      'DEFINITION_DIGEST_MISMATCH',
      'the research skill is not the upstream one its lock pins',
      'A research run follows the vendored skill unmodified; restore it, or review a new lock.',
    );
  }
  return await pinBootstrapFile(tx, activation, {
    runId: pin.runId,
    entryPath: RESEARCH_SKILL.entry,
    manifest: manifest.value,
  });
}

/** The `skills` CLI's folder hash over the files as `source` serves them; undefined if one is unreadable. */
async function folderDigest(
  source: InstructionSource,
  files: readonly string[],
): Promise<string | undefined> {
  const hash = createHash('sha256');
  for (const path of [...new Set(files)].toSorted((a, b) => a.localeCompare(b))) {
    // Sequential: the hash takes the files in order.
    // eslint-disable-next-line no-await-in-loop
    const bytes = await source.read(path);
    if (bytes === undefined) return undefined;
    hash.update(path);
    hash.update(bytes);
  }
  return hash.digest('hex');
}
