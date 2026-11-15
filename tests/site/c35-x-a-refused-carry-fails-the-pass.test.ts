// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2166): the runner's lease runs out between the land that answered `carryDue` and its
// carry. The API refuses the carry with `LEASE_EXPIRED`, the step logs that code and throws
// `PinsUncarried` after its hand-back, so the pass fails, and nothing is carried.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentCall } from '../../apps/site-runner/claims.ts';
import { chromiumAt } from '../../apps/site-runner/picture-browser.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, underReview, type C35World } from '../review/c35-world.ts';
import { carriesOnto, nextRevision, pinOn } from '../review/c35-x-carry.ts';
import { agentCalls, capturePass, queueCapture, replay } from './c35-runner-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X runner refused carry: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35xrunrefuse');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});
afterEach(() => vi.restoreAllMocks());

describe.skipIf(serverUrl === undefined)('C35-X a carry the API refuses', () => {
  it('C35-X a refused carry fails the pass', async () => {
    const reviewed = await underReview(w, 'the runner loses its lease before the carry');
    const transport = replay();
    await queueCapture(w, reviewed);
    await capturePass(w, { call: agentCalls(w), transport, browserAt: chromiumAt });
    await pinOn(w, reviewed.revisionId);
    const second = await nextRevision(w, reviewed);
    await queueCapture(w, reviewed);
    const sent = agentCalls(w);
    // The lease runs out, on the database's clock, just before the carry is sent.
    const call: AgentCall = async (verb, body, pickup) => {
      if (verb === 'review.carry_pins') {
        await w.world.db.admin.execute(
          'update public.leases set expires_at = clock_timestamp() where id = $1',
          [body['leaseId']],
        );
      }
      return await sent(verb, body, pickup);
    };
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(capturePass(w, { call, transport, browserAt: chromiumAt })).rejects.toMatchObject({
      name: 'PinsUncarried',
      code: 'LEASE_EXPIRED',
    });

    const carry = sent.sent.find((one) => one.verb === 'review.carry_pins');
    expect(carry?.answer).toStrictEqual({ refused: 'LEASE_EXPIRED' });
    expect(logged.mock.calls.flat().join(' ')).toContain(
      `review capture ${reviewed.taskId} LEASE_EXPIRED`,
    );
    expect(await carriesOnto(w, second)).toStrictEqual([]);
  }, 180_000);
});
