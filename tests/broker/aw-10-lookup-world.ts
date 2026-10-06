// SPDX-License-Identifier: AGPL-3.0-only
//
// N10-M2's world, on AW-10's (`aw-10-world.ts`): each case its own route, so
// one case's holds never count in another's; holds that fill a route the way
// a model call fills it (`reserveModelCall`, a `reserved` row on the route);
// and the lookups the provider stand-in has been sent.

import { randomUUID } from 'node:crypto';
import { REPLAY_LOOKUP_PATH } from '../../packages/core-connectors/src/index.ts';
import { reserveModelCall, type Broker } from '../../packages/core-custody/src/index.ts';
import { liveWork, type Schedules } from '../runtime/schedules-harness.ts';
import { CLOUD, requestFor, stepOf } from './broker-world.ts';
import { faultBroker, s, world } from './aw-10-world.ts';

/** The fault broker with one route, `key`, holding at most `ceiling` calls in flight. */
export const onRoute = (key: string, ceiling: number): Broker => ({
  ...faultBroker(),
  routes: [{ ...CLOUD, key, ceiling }],
});

/** `count` calls held in flight by `on` on `with_`'s route, as the broker holds them. */
export async function hold(on: Schedules, with_: Broker, count: number): Promise<void> {
  const work = await liveWork(on, `n10m2 hold ${randomUUID()}`, 2_000);
  await stepOf(work);
  const caller = {
    actorId: on.agentActorId,
    delegationId: String(work.picked['delegationId']),
    attendedByPersonId: null,
  };
  for (let n = 0; n < count; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    const held = await on.db.app.withBusiness(
      on.business,
      async (tx) => await reserveModelCall(tx, caller, requestFor(work), with_),
    );
    if (!held.ok) throw new Error(`the hold was refused: ${held.code}`);
  }
}

/** `on`'s calls in flight on the route end, so its room there comes back. */
export async function free(on: Schedules, key: string): Promise<void> {
  await s.db.admin.execute(
    `update public.model_calls set state = 'released', ended_at = clock_timestamp()
      where business_id = $1 and route_key = $2 and state = 'reserved'`,
    [on.business, key],
  );
}

/** How many lookups the provider stand-in has been sent. */
export const lookups = (): number =>
  world.provider.seen.filter((one) => one.path === REPLAY_LOOKUP_PATH).length;

/**
 * `base` with custody holding each lookup until `end` lets it go on or makes
 * it throw; a lookup never ended is a worker lost while asking.
 */
export function heldLookups(base: Broker): {
  readonly broker: Broker;
  readonly arrived: () => number;
  readonly end: (how: 'go' | 'throw') => void;
} {
  let arrived = 0;
  let end: ((how: 'go' | 'throw') => void) | undefined;
  const gate = new Promise<'go' | 'throw'>((resolve) => {
    end = resolve;
  });
  const dispatch: Broker['custody']['dispatch'] = async (credentialRef, request) => {
    arrived += 1;
    if ((await gate) === 'throw') throw new Error('custody could not be reached');
    return await base.custody.dispatch(credentialRef, request);
  };
  return {
    broker: { ...base, custody: { ...base.custody, dispatch } },
    arrived: () => arrived,
    end: (how) => {
      end?.(how);
    },
  };
}
