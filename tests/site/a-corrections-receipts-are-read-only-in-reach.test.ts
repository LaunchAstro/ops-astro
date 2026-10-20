// SPDX-License-Identifier: AGPL-3.0-only
//
// #1694: `live_correction.receipts` answers a correction's receipts (the
// outcome, commit, deployment id and the places the runner checked, cut to
// the receipt text limit) to a reader holding `run:write` at its party and
// `task:read` on its task, both judged inside the query. Every crossing is
// compared byte for byte with the answer to an id that names nothing: another
// business, another client party, a member without read on the task; an agent
// under a live delegation reads none (the read is never an agent's). No
// crossing's body carries the planted correction's id, version, receipt or
// marker.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { RECEIPT_TEXT_LIMIT } from '../../packages/core-records/src/site/index.ts';
import type { Member } from '../commands/fixture.ts';
import {
  LONG,
  MARKER,
  code,
  correctionReadsWorld,
  type ReadsWorld,
} from './correction-reads-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Correction receipts: DATABASE_URL is unset.');

let r: ReadsWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) r = await correctionReadsWorld('c80receipts');
}, 180_000);
afterAll(async () => {
  if (serverUrl !== undefined) await r.w.world.drop();
});

describe.skipIf(serverUrl === undefined)('live_correction.receipts, in reach', () => {
  it('answers the commit, deployment and live place, the place cut to the limit', async () => {
    expect(LONG.length).toBeGreaterThan(RECEIPT_TEXT_LIMIT);
    expect(await r.receiptsAs(r.w.ava, r.live.id)).toStrictEqual({
      ok: true,
      correctionId: r.live.id,
      receipts: [
        {
          receiptId: r.live.receiptId,
          step: 'publish',
          outcome: 'live',
          recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
          commit: 'commit-0123abc',
          deploymentId: 'dpl_live1694',
          // No effect register entry was written for this receipt, so no before place.
          beforeCapture: null,
          afterCapture: { text: `${LONG} beside you.`.slice(0, RECEIPT_TEXT_LIMIT), clipped: true },
        },
      ],
    });
  });

  it('answers a correction with no receipt yet with an empty list', async () => {
    const asked = await r.requested(r.w.ava);
    expect(await r.receiptsAs(r.w.ava, asked.id)).toStrictEqual({
      ok: true,
      correctionId: asked.id,
      receipts: [],
    });
  });

  it('answers a malformed id as one that names nothing, and refuses a non-string', async () => {
    expect(await r.receiptsAs(r.w.ava, 'not-an-id')).toStrictEqual(
      await r.receiptsAs(r.w.ava, randomUUID()),
    );
    expect(code(await r.receiptsAs(r.w.ava, 42))).toBe('FIELD_VALUE_INVALID');
  });
});

/** Who crosses, and in which business. */
const CROSSINGS: readonly (readonly [string, (r: ReadsWorld) => [Member, string]])[] = [
  ['another business', (world) => [world.w.eve, world.w.beta]],
  ['another client party', (world) => [world.w.dee, world.w.world.business]],
  ['a member without read on the task', (world) => [world.hal, world.w.world.business]],
];

describe.skipIf(serverUrl === undefined)('live_correction.receipts, across a boundary', () => {
  it.each(CROSSINGS)('%s reads them exactly as an id that names nothing', async (_, who) => {
    const [member, business] = who(r);
    const crossed = await r.receiptsAs(member, r.live.id, business);
    expect(code(crossed)).toBe('NOT_FOUND');
    expect(crossed).toStrictEqual(await r.receiptsAs(member, randomUUID(), business));
    for (const marker of [r.live.id, r.live.versionId, r.live.receiptId, MARKER]) {
      expect(JSON.stringify(crossed)).not.toContain(marker);
    }
  });

  it('an agent under a live delegation reads none, its own task’s included', async () => {
    const picked = await r.w.pickUpUnder(r.w.ava, 'the about page, receipts', r.w.partyA);
    const ask = async (correctionId: string) =>
      await r.w.world.asAgent(
        { command: 'live_correction.receipts', operationId: randomUUID(), correctionId },
        picked.credential,
      );
    const onLive = await ask(r.live.id);
    expect(codeOf(onLive)).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(await ask(randomUUID())).toStrictEqual(onLive);
    expect(JSON.stringify(onLive)).not.toContain(r.live.id);
  });

  it('a member holding run:write nowhere is refused alike for a real and an unknown id', async () => {
    const real = await r.receiptsAs(r.w.admin, r.live.id);
    expect(code(real)).toBe('SCOPE_NOT_GRANTED');
    expect(real).toStrictEqual(await r.receiptsAs(r.w.admin, randomUUID()));
  });
});
