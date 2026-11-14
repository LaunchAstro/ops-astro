// SPDX-License-Identifier: AGPL-3.0-only
//
// #2478: `d06-generated.test.ts` runs for hours as one file, and its people's
// bearers last an hour, so every cell after the first hour answered
// `AUTH_SESSION_EXPIRED` (main 4445967: 17,934 of 23,103 failed in 3,822 s).
// The file now signs its people in again on a schedule. This proves the two
// halves without waiting an hour: the harness's `signInAgain` replaces every
// bearer a cell is sent with, on all three surfaces, and the schedule calls it
// once its interval has passed on the clock it is given.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signInSchedule, surfacesOf, SURFACES, type Said, type Surface } from './d06-cases.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { createHarness, type Harness } from './role-case-harness.ts';
import { serverUrl } from './world.ts';

const EXPIRED = 'AUTH_SESSION_EXPIRED';

describe('the d06 sign-in schedule', () => {
  it('signs in again once the interval has passed, and not before', async () => {
    let now = 1_000;
    let signIns = 0;
    const due = signInSchedule(
      async () => {
        signIns += 1;
        await Promise.resolve();
      },
      600,
      () => now,
    );
    now += 599;
    expect(await due()).toBe(false);
    now += 1;
    expect(await due()).toBe(true);
    expect(signIns).toBe(1);
    // Measured from the last sign-in, not from the first.
    now += 599;
    expect(await due()).toBe(false);
    now += 1;
    expect(await due()).toBe(true);
    expect(signIns).toBe(2);
  });
});

describe.skipIf(serverUrl === undefined)('the d06 harness signs its people in again', () => {
  let harness: Harness;
  let send: (surface: Surface, name: CommandName, body: Record<string, unknown>) => Promise<Said>;

  beforeAll(async () => {
    harness = await createHarness('d06s');
    // Made before the bearers change, as `d06-generated` makes it once in `beforeAll`.
    send = surfacesOf(harness);
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  /** One call per bearer the harness holds, each answering its code. */
  async function codes(): Promise<Readonly<Record<string, string>>> {
    const { world } = harness;
    const out: Record<string, string> = {};
    for (const surface of SURFACES) {
      // eslint-disable-next-line no-await-in-loop -- one door at a time
      out[`ada on ${surface}`] = (await send(surface, 'session.person', {})).code;
    }
    for (const caller of [world.mia, world.noah, world.orphan, world.bea, ...harness.clients]) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await harness.asPerson('session.person', {}, caller.businessKey, caller);
      out[caller.name] = answer.code;
    }
    out['agent'] = (await harness.asAgent('task.pickup', { reservationId: randomUUID() })).code;
    return out;
  }

  it('every bearer a cell is sent with is the one signed in last', async () => {
    const fresh = await codes();
    expect(Object.values(fresh), 'signed in at the start').not.toContain(EXPIRED);

    // Bearers already past their end: what an hour into the old run looked like.
    await harness.signInAgain({ expiresIn: -600 });
    const lapsed = await codes();
    expect(lapsed).toStrictEqual(Object.fromEntries(Object.keys(fresh).map((k) => [k, EXPIRED])));

    await harness.signInAgain();
    expect(await codes(), 'signed in again: every answer as at the start').toStrictEqual(fresh);
  }, 60_000);
});
