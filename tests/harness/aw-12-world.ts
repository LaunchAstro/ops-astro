// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: the trigger read's world. AW-11's child world (two
// businesses, picked-up work under a live delegation, a helper agent of each)
// with a pin of a chosen reading on a run, and the read as a member calls it.

import { createHash, randomUUID } from 'node:crypto';
import { readHarnessTrigger } from '../../packages/core-commands/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import { withSession } from '../../packages/core-records/src/identity/login-resolution.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import type { Schedules, Work } from '../runtime/schedules-harness.ts';
import { childRequest, parentWork, type Helper } from '../runtime/aw-11-child-world.ts';
import { delegateOn } from '../runtime/aw-11-child-work-world.ts';

const hex = (text: string): string => createHash('sha256').update(text).digest('hex');

export const runOf = (work: Work): string => String(work.picked['runId']);

/**
 * The run's accept-time manifest, one file per size, seeded by the admin
 * connection as AW-02's grant test seeds one. `entries` overrides the
 * manifest itself, for a malformed one.
 */
export async function pinReading(
  on: Schedules,
  runId: string,
  sizes: readonly number[],
  entries?: readonly unknown[],
): Promise<void> {
  const manifest =
    entries ??
    sizes.map((size, index) => ({
      path: `skills/f${String(index)}.md`,
      digest: hex(`${runId}${String(index)}`),
      size,
    }));
  await on.db.admin.execute(
    `insert into public.run_definition_pins
       (business_id, run_id, ref_kind, path, content_digest, content_size, read_at,
        manifest, manifest_digest, pinned_by_actor_id)
     values ($1, $2, 'bootstrap_file', 'skills/f0.md', $3, $4, now(), $5::text::jsonb, $6, $7)`,
    [
      on.business,
      runId,
      hex(`${runId}0`),
      sizes[0] ?? 0,
      JSON.stringify(manifest),
      hex(JSON.stringify(manifest)),
      on.decider.actorId,
    ],
  );
}

/** Picked-up work with a pinned reading, handed in part to `helper` when one is given. */
export async function shapedWork(
  on: Schedules,
  sizes: readonly number[],
  helper?: Helper,
  title = `aw-12 ${randomUUID()}`,
): Promise<{ readonly work: Work; readonly runId: string; readonly childId: string | null }> {
  const { work, parent } = await parentWork(on, title);
  const runId = runOf(work);
  if (sizes.length > 0) await pinReading(on, runId, sizes);
  if (helper === undefined) return { work, runId, childId: null };
  const handed = await delegateOn(on, parent, work, childRequest(helper));
  if (!handed.ok) throw new Error(`the helper was not handed the work: ${handed.refusal.code}`);
  return { work, runId, childId: handed.value.childDelegationId };
}

/** The trigger read on `runId`, as `who` signed in to `on`'s business. */
export async function triggerAs(
  on: Schedules,
  who: Member | { readonly presented: VerifiedSubject },
  runId: string,
): Promise<unknown> {
  return await withSession(
    on.db.app,
    on.business,
    who.presented,
    async (tx, session) => await readHarnessTrigger(tx, session, runId),
  );
}
