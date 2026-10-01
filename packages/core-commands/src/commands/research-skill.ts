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
// Each file is read once, and the digest checked and the manifest pinned are
// both over those bytes, so a folder that changes mid-pin cannot pass one
// read and pin another.
//
// The start reads the folder from the repository the process runs from
// (`directorySource`, as wf-6 reads its vendored skill): the deployed API runs
// from the checkout (`apps/api/server.ts`'s ROOT), and the instruction root
// (`OPS_ASTRO_INSTRUCTION_ROOT`) holds plans' files, not vendored skills.

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  admitActivation,
  captureManifest,
  directorySource,
  pinBootstrapFile,
  refuse,
  type Activator,
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

/** The repository the process runs from: this file is `packages/core-commands/src/commands/`. */
const REPOSITORY = join(import.meta.dirname, '..', '..', '..', '..');

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
  const once = await readOnce(pin.source, pin.files);
  const manifest = await captureManifest(once, pin.files);
  if (!manifest.ok) return manifest;
  if ((await folderDigest(once, pin.files)) !== RESEARCH_SKILL.digest) {
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

/**
 * WF-7: the skill pinned on a research run a person started, by that person,
 * from the repository's vendored folder. Called by `task.propose` in the
 * start's transaction; a refusal refuses the start. An agent starter is
 * refused first (`admitActivation`), before the folder is read.
 */
export async function pinResearchSkillOnStart(
  tx: TenantQuery,
  start: { readonly runId: string; readonly starter: Activator },
): Promise<RuntimeResult<FileIdentity>> {
  const admitted = admitActivation({ mode: 'manual', activator: start.starter });
  if (!admitted.ok) return admitted;
  const folder = join(REPOSITORY, RESEARCH_SKILL.folder);
  return await pinResearchSkill(tx, admitted.value, {
    runId: start.runId,
    source: directorySource(folder),
    files: await filesUnder(folder),
  });
}

/**
 * Every file under the folder, `/`-separated and relative to it, `.git` and
 * `node_modules` skipped as the `skills` CLI skips them; none if it is gone,
 * which the digest then refuses.
 */
async function filesUnder(folder: string, at = ''): Promise<readonly string[]> {
  const entries = await readdir(join(folder, at), { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = at === '' ? entry.name : `${at}/${entry.name}`;
      if (entry.isDirectory()) {
        return entry.name === '.git' || entry.name === 'node_modules'
          ? []
          : await filesUnder(folder, path);
      }
      return entry.isFile() ? [path] : [];
    }),
  );
  return nested.flat();
}

/** Each file read from `source` once, served from those bytes after. */
async function readOnce(
  source: InstructionSource,
  files: readonly string[],
): Promise<InstructionSource> {
  const bytes = new Map<string, Uint8Array | undefined>();
  for (const path of new Set(files)) {
    // Sequential: one file at a time, as the manifest capture reads them.
    // eslint-disable-next-line no-await-in-loop
    bytes.set(path, await source.read(path));
  }
  const available = source.available?.bind(source);
  return {
    read: async (path) => await Promise.resolve(bytes.get(path)),
    ...(available === undefined ? {} : { available }),
  };
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
