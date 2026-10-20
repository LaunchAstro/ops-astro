// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2166): the site runner lands a review's second revision at both widths against the
// replay site, and the land that answers `carryDue` is followed, in the same pass and under the
// same lease, by one `review.carry_pins` call of its own: the pin before it is carried once, by
// the carry's operation and never a land's. Nothing crosses: client B's review in the same
// business and the beta business carry nothing, and the call names no actor or person.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumAt } from '../../apps/site-runner/picture-browser.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { B_FILE, B_PAGE, c35World, underReview, type C35World } from '../review/c35-world.ts';
import { underLease } from '../review/c35-landing.ts';
import {
  carriesOnto,
  carryCount,
  landedReview,
  must,
  nextRevision,
  pinOn,
} from '../review/c35-x-carry.ts';
import { agentCalls, capturePass, leaseOn, queueCapture, replay } from './c35-runner-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X runner carry: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35xruncarry');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** The operation ids of `command`'s applied audit rows in the business. */
const operationsOf = async (command: string): Promise<readonly string[]> =>
  (
    await w.world.db.admin.execute<{ readonly operation_id: string }>(
      `select distinct operation_id from public.audit_events
        where business_id = $1 and command = $2 and outcome = 'applied'`,
      [w.world.business, command],
    )
  ).map((row) => row.operation_id);

/**
 * Client B's review with a pin and a next revision, its lease handed back so the runner's queue
 * shows A's capture, and the beta business's carry count.
 */
async function elsewhere(): Promise<{ readonly secondB: string; readonly beta: number }> {
  const atB = { partyId: w.partyB, pageUrl: B_PAGE, path: B_FILE };
  const page = { text: 'Book a visit today.', document: 'b' };
  const b = await landedReview(w, 'client B review', page, atB);
  await pinOn(w, b.reviewed.revisionId);
  const back = { command: 'task.handback', outcome: 'completed', report: {} };
  must((await underLease(w, b.lease, back)).result, 'task.handback');
  return { secondB: await nextRevision(w, b.reviewed, atB), beta: await carryCount(w, w.beta) };
}

describe.skipIf(serverUrl === undefined)('C35-X the site runner carries pins', () => {
  it('C35-X the runner carries after the land that answers carryDue', async () => {
    const { secondB, beta } = await elsewhere();
    const reviewed = await underReview(w, 'the runner carries the about page pins');
    await queueCapture(w, reviewed);
    const transport = replay();
    await capturePass(w, { call: agentCalls(w), transport, browserAt: chromiumAt });
    const pin = await pinOn(w, reviewed.revisionId);
    const second = await nextRevision(w, reviewed);
    await queueCapture(w, reviewed);
    const call = agentCalls(w);

    const captured = await capturePass(w, { call, transport, browserAt: chromiumAt });

    expect(captured).toStrictEqual([{ taskId: reviewed.taskId, outcome: 'landed' }]);
    const lands = call.sent.filter((one) => one.verb === 'review.capture_land');
    expect(
      lands.map((one) => (one.answer as { detail: Record<string, unknown> }).detail['carryDue']),
    ).toStrictEqual([false, true]);
    // One carry, after the land that answered carryDue and before the hand-back, on its lease.
    const verbs = call.sent.map((one) => one.verb);
    expect(verbs.filter((verb) => verb === 'review.carry_pins')).toHaveLength(1);
    expect(verbs.slice(verbs.lastIndexOf('review.capture_land') + 1)).toStrictEqual([
      'review.carry_pins',
      'task.handback',
    ]);
    const carry = call.sent.find((one) => one.verb === 'review.carry_pins');
    const lease = await leaseOn(w, reviewed.taskId);
    expect(lease?.holder).toBe(w.world.agentActorId);
    expect(carry?.body).toStrictEqual({
      leaseId: lease?.id,
      fence: lands[1]?.body['fence'],
      revisionId: second,
    });
    expect(carry?.pickup).toBe(lands[1]?.pickup);

    // The pin is carried once, by the carry's own operation, never inline in a land.
    const carries = await carriesOnto(w, second);
    expect(carries.map((row) => [row.comment_id, row.from_revision_id])).toStrictEqual([
      [pin, reviewed.revisionId],
    ]);
    const operation = carries[0]?.operation_id;
    expect(await operationsOf('review.carry_pins')).toStrictEqual([operation]);
    expect(await operationsOf('review.capture_land')).not.toContain(operation);

    // Client B's review and the beta business carry nothing.
    expect(await carriesOnto(w, secondB)).toStrictEqual([]);
    expect(await carryCount(w, w.beta)).toBe(beta);
  }, 180_000);
});
