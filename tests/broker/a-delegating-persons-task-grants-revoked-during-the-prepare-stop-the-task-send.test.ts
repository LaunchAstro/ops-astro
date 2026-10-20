// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried task call rests on the delegating person's task grants (#1703,
// #1620 P5, Sol's proof on #2009, assertions unchanged): revoked during the
// model agent's prepare, so that the delegation no longer carries task
// authority, the send judgement after that wait sees it and nothing is sent.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDelegatedAuthority,
  resolveDelegation,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { s, useBrokerWorld } from './broker-world.ts';
import { carriedCall, openCarriedTaskWorld, type CarriedTaskWorld } from './carried-task-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('carrygrants');

describe.skipIf(serverUrl === undefined)("a delegating person's task authority", () => {
  let world: CarriedTaskWorld;
  beforeAll(async () => {
    world = await openCarriedTaskWorld();
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  });

  it('stops the send when the delegating person loses task authority during the prepare', async () => {
    const work = await liveWork(s, `Sol revoked authority ${randomUUID()}`, 2000);
    let reached = false;
    let denied = false;
    world.duringPrepare = async () => {
      reached = true;
      await s.db.admin.execute(
        `update public.grants set revoked_at = clock_timestamp()
          where business_id = $1 and subject_kind = 'person' and subject_id = $2
            and collection = 'task' and revoked_at is null`,
        [s.business, s.decider.personId],
      );
      denied = await s.db.app.withBusiness(s.business, async (tx) => {
        const delegation = await resolveDelegation(
          tx,
          s.agentActorId,
          String(work.picked['credential']),
        );
        if (!delegation.ok) return true;
        const authority = await checkDelegatedAuthority(tx, delegation.value, {
          collection: 'task',
          action: 'read',
          scope: { kind: 'record', id: work.taskId },
        });
        return !authority.ok;
      });
    };
    const sent = world.plan.sent.length;
    try {
      await carriedCall(world, work);
      expect(reached).toBe(true);
      expect(denied).toBe(true);
      expect(world.plan.sent.length - sent).toBe(0);
    } finally {
      world.duringPrepare = async () => {};
    }
  }, 60_000);
});
