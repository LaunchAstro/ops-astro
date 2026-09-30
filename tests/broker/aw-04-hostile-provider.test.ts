// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 hostile provider` (U10, the money half): a planning reply that comes
// back oversized, redirected, schema-invalid (the replay's `malformed` body and
// its `bad_model` id), past the timeout or priced above its hold is held within
// its own hold; one the provider proves never began is released. Either way it
// offers no text, the business's planning cap commits at most the operation's
// priced maximum, the conversation's envelope reads the same amount, and the
// reply that no longer fits is refused with nothing written or sent. Composing
// a plan version from a reply is SL12's panel: `AW-04 hostile provider: a
// hostile planning reply composes no plan version` (LEANS-ON SL12 MP-7-11).
//
// `AW-04 canary` gains its planning leg here: the planted chat content and the
// planted provider answer reach no row, audit payload or custody log.

import { expect, it as vitestIt } from 'vitest';
import type { ReplayMode } from '../../packages/core-connectors/src/index.ts';
import { callCount, noDatabase, PLANTED_PROMPT, s, world } from './broker-world.ts';
import {
  allowance,
  ask,
  ownerOf,
  plan,
  rowsFor,
  setCap,
  usePlanningWorld,
} from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('aw04host');

/** The replay's priced maximum for `model.replay_compose` (REPLAY_COMPOSE.maximumMinor). */
const MAXIMUM = 500;

const HELD: readonly ReplayMode[] = [
  'oversized',
  'redirect',
  'malformed',
  'bad_model',
  'slow',
  'costly',
];

/** One hostile reply on its own conversation: held at the maximum, no text, cap and envelope agreeing. */
async function heldWithin(mode: ReplayMode): Promise<void> {
  const request = ask(s);
  const id = request.conversation.id;
  const before = await allowance(s, s.decider.personId, id);
  world.provider.mode(mode);
  const result = await plan(s, ownerOf(s), request);
  expect(result, mode).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN', heldMinor: MAXIMUM });
  expect(result, mode).not.toHaveProperty('text');
  const after = await allowance(s, s.decider.personId, id);
  expect(before.leftMinor - after.leftMinor, mode).toBe(MAXIMUM);
  expect(after.conversation, mode).toStrictEqual({ spentMinor: 0, heldMinor: MAXIMUM });
  const rows = await rowsFor(s, id);
  expect(rows, mode).toHaveLength(1);
  expect(rows[0], mode).toMatchObject({
    state: 'liability_unknown',
    reserved_minor: String(MAXIMUM),
    actual_minor: null,
    run_id: null,
  });
  expect(rows[0]?.['planning_envelope_id'], mode).toEqual(expect.any(String));
}

it('AW-04 hostile provider: each hostile planning reply is held within its own hold, offers no text, and the cap and the envelope move by at most the maximum', async () => {
  // Room for exactly one hold per hostile mode, and one short of another.
  await setCap(s, HELD.length * MAXIMUM + MAXIMUM - 1);
  for (const mode of HELD) {
    // eslint-disable-next-line no-await-in-loop
    await heldWithin(mode);
  }
  // Only the priced reply names what it saw: above the hold, never settled at it.
  const costly = await s.db.admin.execute<{ observed: string | null }>(
    `select observed_minor::text as observed from public.model_calls
      where business_id = $1 and planning_envelope_id is not null and observed_minor is not null`,
    [s.business],
  );
  expect(costly.map((row) => Number(row.observed))).toStrictEqual([1_000]);

  const request = ask(s);
  expect(await allowance(s, s.decider.personId, request.conversation.id)).toMatchObject({
    leftMinor: MAXIMUM - 1,
  });
  world.provider.mode('answer');
  const calls = await callCount();
  const sent = world.provider.seen.length;
  expect(await plan(s, ownerOf(s), request)).toStrictEqual({
    ok: false,
    code: 'BUDGET_UNAVAILABLE',
    callId: null,
  });
  expect(await callCount()).toBe(calls);
  expect(world.provider.seen.length).toBe(sent);
}, 60_000);

it('AW-04 hostile provider: a reply the provider proves never began is released whole and commits nothing', async () => {
  await s.db.admin.execute(
    `update public.budget_caps set limit_minor = limit_minor + $2
      where business_id = $1 and key = 'planning'`,
    [s.business, MAXIMUM],
  );
  const request = ask(s);
  const before = await allowance(s, s.decider.personId, request.conversation.id);
  world.provider.mode('nothing_happened');
  const result = await plan(s, ownerOf(s), request);
  expect(result).toMatchObject({ ok: false, code: 'CALL_RELEASED' });
  expect(result).not.toHaveProperty('text');
  const after = await allowance(s, s.decider.personId, request.conversation.id);
  expect(after.leftMinor).toBe(before.leftMinor);
  expect(after.conversation).toStrictEqual({ spentMinor: 0, heldMinor: 0 });
  expect(await rowsFor(s, request.conversation.id)).toMatchObject([
    { state: 'released', reserved_minor: String(MAXIMUM), actual_minor: null },
  ]);
});

it('AW-04 canary: planted chat content and a planted provider answer on a planning reply reach no row, audit payload or custody log', async () => {
  await s.db.admin.execute(
    `update public.budget_caps set limit_minor = limit_minor + $2
      where business_id = $1 and key = 'planning'`,
    [s.business, MAXIMUM],
  );
  const planted = '203.0.113.9/collect';
  world.provider.mode('planted');
  const answered = await plan(s, ownerOf(s), ask(s));
  expect(answered).toMatchObject({ ok: true, reservedMinor: MAXIMUM });
  // The answer is the caller's data; it is never kept or logged.
  expect(answered.ok && answered.text).toContain(planted);
  world.provider.mode('malformed');
  const refused = await plan(s, ownerOf(s), ask(s));
  expect(refused).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
  const [row] = await s.db.admin.execute<{ dump: string }>(
    `select coalesce(string_agg(t, ' '), '') as dump from (
       select row_to_json(m)::text as t from public.model_calls m where m.business_id = $1
       union all select row_to_json(e)::text from public.planning_envelopes e
        where e.business_id = $1
       union all select row_to_json(a)::text from public.audit_events a where a.business_id = $1
       union all select row_to_json(c)::text from public.copy_registrations c
        where c.business_id = $1) rows`,
    [s.business],
  );
  const dump = row?.dump ?? '';
  for (const secret of [PLANTED_PROMPT, planted, world.canary]) {
    expect(dump).not.toContain(secret);
    expect(world.custody.stderr()).not.toContain(secret);
    expect(JSON.stringify(refused)).not.toContain(secret);
  }
  // The dump is not vacuous: it holds this business's planning rows, and the
  // provider did receive the planted prompt.
  expect(dump).toContain(s.business);
  expect(world.provider.seen.some((request) => request.body.includes(PLANTED_PROMPT))).toBe(true);
});
