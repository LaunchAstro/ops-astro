// SPDX-License-Identifier: AGPL-3.0-only
//
// The revert ask's shared steps on the C80 world: a correction brought to
// `live` (ava requests, ben approves, then the owner records it live, as an
// observed publish would), the ask's body, and what the store holds of the
// asks on one correction.

import { expect } from 'vitest';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import type { C80World } from './c80-world.ts';

export interface Asked {
  readonly correctionId: string;
  readonly versionId: string;
}

/** Ava's request on party A's about page, through the command. */
export async function requested(w: C80World): Promise<Asked> {
  const asked = await w.request(w.ava);
  expect(codeOf(asked)).toBe('not-a-refusal');
  const detail = detailOf(asked);
  return { correctionId: String(detail['correctionId']), versionId: String(detail['versionId']) };
}

/** That request approved by ben, the configured approver. */
export async function approved(w: C80World): Promise<Asked> {
  expect(codeOf(await w.setApprover(w.ben.personId))).toBe('not-a-refusal');
  const asked = await requested(w);
  expect(codeOf(await w.approve(w.ben, asked.correctionId, asked.versionId))).toBe('not-a-refusal');
  return asked;
}

/** Move a correction to `state` as the owner, the way the runner's observed result does. */
export async function moveTo(w: C80World, correctionId: string, state: string): Promise<void> {
  await w.world.db.admin.execute(
    `update public.live_corrections set state = $2, revision = revision + 1, updated_at = now()
      where id = $1`,
    [correctionId, state],
  );
}

/** An approved correction recorded live, with ben configured as its approver. */
export async function live(w: C80World): Promise<Asked> {
  const asked = await approved(w);
  await moveTo(w, asked.correctionId, 'live');
  expect(await w.stateOf(asked.correctionId)).toBe('live');
  return asked;
}

export const revertBody = (correctionId: string): Readonly<Record<string, unknown>> => ({
  command: 'live_correction.revert',
  correctionId,
});

export interface StoredAsk {
  readonly id: string;
  readonly askedByPersonId: string;
}

/** Every revert ask stored on one correction, read as the owner. */
export async function asksOn(w: C80World, correctionId: string): Promise<readonly StoredAsk[]> {
  const rows = await w.world.db.admin.execute<{ readonly id: string; readonly person: string }>(
    `select id, asked_by_person_id as person from public.live_correction_revert_asks
      where correction_id = $1`,
    [correctionId],
  );
  return rows.map((row) => ({ id: row.id, askedByPersonId: row.person }));
}
