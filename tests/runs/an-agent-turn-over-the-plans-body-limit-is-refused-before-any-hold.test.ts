// SPDX-License-Identifier: AGPL-3.0-only
//
// A turn too large for its route is refused before any hold (#2091, gap 5
// and v2-3). Reserve builds the request from the bound fields and sizes it
// against the adapter's body limit: one byte over, the call is refused
// `PROMPT_TOO_LARGE`, the only row it leaves is that refusal (no hold, no
// release), no prompt copy is registered, nothing is sent, and the attempt
// ends `cancelled`. A turn exactly at the limit is held and sent.

import { describe, expect, it } from 'vitest';
import { liveWork } from '../runtime/schedules-harness.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  asAgent,
  durable,
  leaseOf,
  s,
  signedIn,
  useDoorWorld,
  world,
} from './run-stop-door-world.ts';
import { callsAndCopies, sizedBroker, sizing } from './size-world.ts';
import { replied, taskPart, turnBody } from './turn-world.ts';

const serverUrl = databaseUrlFromEnvironment();
const TITLE = 'plan turn sized before the hold';

/** One turn 0 on fresh work under the limit set now; the answer, the work and the bytes reserve built. */
async function turnUnder(limit: number) {
  sizing.limit = limit;
  sizing.built.length = 0;
  const work = await liveWork(s, TITLE, 2_000);
  const as = await signedIn();
  world.provider.script([replied('Read it.')]);
  const seen = world.provider.seen.length;
  const answer = await asAgent('/model/call', work, turnBody(work, 0, [await taskPart(work)]), as);
  // The first build's bytes: the hold's, or the send's where the hold builds none (the same bytes).
  const held = sizing.built[0]?.bytes ?? 0;
  return { answer, work, held, sent: world.provider.seen.length - seen };
}

describe.skipIf(serverUrl === undefined)('a turn sized at its hold', () => {
  useDoorWorld('planturnsize', sizedBroker);

  it('refuses one a byte over the limit with nothing held, copied or sent', async () => {
    const probe = await turnUnder(Number.MAX_SAFE_INTEGER);
    expect(probe.sent, 'the probe is sent').toBe(1);
    const over = await turnUnder(probe.held - 1);
    expect(over.answer.body['code'], JSON.stringify(over.answer.body)).toBe('PROMPT_TOO_LARGE');
    expect(over.sent, 'nothing was sent').toBe(0);
    const { states, copies } = await callsAndCopies(leaseOf(over.work));
    expect(states, 'the refusal is the only row: no hold and no release').toStrictEqual([
      'refused',
    ]);
    expect(copies, 'no prompt copy is registered').toBe(0);
    const after = await durable(over.work);
    expect(after.calls).toStrictEqual([{ state: 'refused', refusal_code: 'PROMPT_TOO_LARGE' }]);
    expect(after.outcomes).toMatchObject([{ outcome: 'cancelled', end_code: 'PROMPT_TOO_LARGE' }]);
  }, 60_000);

  it('holds and sends one exactly at the limit', async () => {
    const probe = await turnUnder(Number.MAX_SAFE_INTEGER);
    const at = await turnUnder(probe.held);
    expect(at.held).toBe(probe.held);
    expect(at.sent).toBe(1);
    expect((await callsAndCopies(leaseOf(at.work))).states).toStrictEqual(['settled']);
  }, 60_000);
});
