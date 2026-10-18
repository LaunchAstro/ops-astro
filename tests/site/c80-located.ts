// SPDX-License-Identifier: AGPL-3.0-only
//
// The C80 world's stand-in for the site runner's pin (#1693): a request is
// stored `locating`, and tests that start past the locate pin it here from
// the fixture file at a 40-hex revision, with the digests the runner computes.
// The locate itself is proved by tests/site/the-runner-*.

import { randomUUID } from 'node:crypto';
import type { AgentWorld } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import {
  contentDigest,
  replaced,
  versionDigestOf,
} from '../../packages/core-connectors/src/index.ts';

export const BEFORE: string =
  '---\ntitle: About\n---\n\nWe are a friendly studio.\n\nA friendly decoy line.\n';
export const AFTER: string =
  '---\ntitle: About\n---\n\nWe are a welcoming studio.\n\nA friendly decoy line.\n';
/** The commit the stand-in pin names: a 40-hex revision, as the storage requires. */
export const REV: string = `c0ffee${'0'.repeat(34)}`;

/**
 * The runner's pin, stood in for: the correction pinned from `BEFORE` at `REV`, checked now, with
 * the digests the runner computes. One already pinned answers its own version.
 */
export async function pinFromBefore(
  admin: AgentWorld['db']['admin'],
  correctionId: string,
): Promise<{ readonly versionId: string; readonly versionDigest: string }> {
  const [row] = await admin.execute<{
    readonly target_path: string;
    readonly word: string;
    readonly replacement: string;
    readonly page_url: string;
    readonly seam: string;
    readonly version_id: string | null;
    readonly version_digest: string | null;
  }>(
    `select target_path, word, replacement, page_url, seam, version_id, version_digest
       from public.live_corrections where id = $1`,
    [correctionId],
  );
  if (row === undefined) throw new Error('pinFromBefore: no such correction');
  if (row.version_id !== null && row.version_digest !== null)
    return { versionId: row.version_id, versionDigest: row.version_digest };
  const target = { path: row.target_path, word: row.word, replacement: row.replacement };
  const after = replaced(BEFORE, row.word, row.replacement) ?? AFTER;
  const preImageDigest = contentDigest(BEFORE);
  const versionDigest = versionDigestOf({
    target,
    change: { files: [{ path: row.target_path, before: BEFORE, after }] },
    preImageDigest,
    baseRevision: REV,
    pageUrl: row.page_url,
    seam: row.seam,
  });
  const versionId = randomUUID();
  await admin.execute(
    `update public.live_corrections
        set pre_image_digest = $2, base_revision = $3, version_id = $4::uuid,
            version_digest = $5, located_at = clock_timestamp(),
            verified_at = clock_timestamp(), state = 'requested'
      where id = $1 and state = 'locating'`,
    [correctionId, preImageDigest, REV, versionId, versionDigest],
  );
  return { versionId, versionDigest };
}

/** An applied request, pinned as the runner would and answered with its version. */
export async function located(
  world: AgentWorld,
  body: Readonly<Record<string, unknown>>,
  result: CommandResult,
): Promise<CommandResult> {
  if (body['command'] !== 'live_correction.request' || isCommandRefusal(result)) return result;
  const correctionId = String(result.detail['correctionId']);
  const pinned = await pinFromBefore(world.db.admin, correctionId);
  return { ...result, detail: { ...result.detail, ...pinned, state: 'requested' } };
}
