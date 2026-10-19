// SPDX-License-Identifier: AGPL-3.0-only
//
// The send sizes a held turn again (#2091, gap v2-3), apart from the hold:
// here the adapter's send build is padded past the limit the hold passed,
// so a hold stands and only the send can catch it. Custody is asked nothing,
// the provider is sent nothing, and the call is released unsent as
// `PROMPT_TOO_LARGE`, never held as unknown.

import { afterEach, describe, expect, it } from 'vitest';
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

describe.skipIf(serverUrl === undefined)('a held turn sized again at its send', () => {
  useDoorWorld('planturnsend', sizedBroker);
  afterEach(() => {
    sizing.grow = 0;
    sizing.limit = Number.MAX_SAFE_INTEGER;
  });

  it('is released unsent, and custody is asked nothing', async () => {
    sizing.limit = 64 * 1024;
    sizing.grow = 64 * 1024;
    sizing.built.length = 0;
    const work = await liveWork(s, 'plan turn sized at the send', 2_000);
    const as = await signedIn();
    world.provider.script([replied('Read it.')]);
    const seen = world.provider.seen.length;
    const answer = await asAgent(
      '/model/call',
      work,
      turnBody(work, 0, [await taskPart(work)]),
      as,
    );
    expect(sizing.built.map((one) => one.atSend)).toStrictEqual([false, true]);
    expect(world.provider.seen.length - seen, 'custody sent nothing').toBe(0);
    expect(JSON.stringify(answer.body)).toContain('PROMPT_TOO_LARGE');
    const { states } = await callsAndCopies(leaseOf(work));
    expect(states, 'released unsent, never held').toStrictEqual(['released']);
    const after = await durable(work);
    expect(after.outcomes).toMatchObject([{ end_code: 'PROMPT_TOO_LARGE' }]);
  }, 60_000);
});
