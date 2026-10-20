// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2166): the site runner calls `review.carry_pins` only when a land answers
// `carryDue`. A review's first revision has no pin before it, and a second revision of a review
// with no pin has nothing to carry: each lands at both widths, every land answers false, and
// the pass makes no carry call and writes no carry.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumAt } from '../../apps/site-runner/picture-browser.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, underReview, type C35World } from '../review/c35-world.ts';
import { carryCount, nextRevision } from '../review/c35-x-carry.ts';
import { agentCalls, capturePass, queueCapture, replay } from './c35-runner-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X runner no carry: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35xrunnone');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35-X the site runner carries only when due', () => {
  it('C35-X the runner makes no carry call when no carry is due', async () => {
    const reviewed = await underReview(w, 'the runner lands with nothing to carry');
    const transport = replay();
    const call = agentCalls(w);
    await queueCapture(w, reviewed);
    const first = await capturePass(w, { call, transport, browserAt: chromiumAt });
    await nextRevision(w, reviewed);
    await queueCapture(w, reviewed);
    const second = await capturePass(w, { call, transport, browserAt: chromiumAt });

    const landed = [{ taskId: reviewed.taskId, outcome: 'landed' }];
    expect([first, second]).toStrictEqual([landed, landed]);
    const lands = call.sent.filter((one) => one.verb === 'review.capture_land');
    expect(lands).toHaveLength(4);
    for (const land of lands) {
      expect((land.answer as { detail: Record<string, unknown> }).detail['carryDue']).toBe(false);
    }
    expect(call.sent.map((one) => one.verb)).not.toContain('review.carry_pins');
    expect(await carryCount(w, w.world.business)).toBe(0);
  }, 180_000);
});
