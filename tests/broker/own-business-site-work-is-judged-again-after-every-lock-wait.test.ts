// SPDX-License-Identifier: AGPL-3.0-only
//
// R6, part 2 (#1699): source and party are judged again after every lock
// wait, at the model call's admission and at the agent's correction request
// on the business's own site, each race run on a connection of its own. A
// client set, or a write by someone other than the owner, committed during
// the wait is seen after it and refused, with nothing sent or stored. A replay
// holds its task from before its audit-chain wait, so a client set meanwhile
// waits for the replay.

import { describe, expect, it } from 'vitest';
import { advisoryLock } from '../../packages/core-records/src/index.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { held, seenWaiting, type Held } from '../site/party-site-races.ts';
import {
  ask,
  ownBody,
  requestOwn,
  sends,
  serverUrl,
  storedOn,
  useOwnSiteWorld,
  w,
  workedBy,
  wrote,
} from './own-site-broker-world.ts';

if (serverUrl === undefined)
  console.warn('Own-business site races: DATABASE_URL is unset, so nothing ran.');

useOwnSiteWorld('own1699race');

describe.skipIf(serverUrl === undefined)('at the model call’s admission', () => {
  it('sees a client set on the task during the admission’s wait, and sends nothing', async () => {
    const picked = await workedBy('owner', 'Our about page, client during wait');
    const setting = held(w, async (tx) => {
      await tx.query(
        `update public.records set data = jsonb_set(data, '{client}', to_jsonb($2::text))
          where business_id = $1 and id = $3`,
        [tx.businessId, w.partyA, picked.taskId],
      );
    });
    await setting.ready;
    const before = sends();
    const answer = ask(picked);
    const waited = await seenWaiting(w, /for share of t/u);
    setting.release();
    await setting.done;
    expect(await answer).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK' });
    expect(waited).toBe(true);
    expect(sends()).toBe(before);
  }, 120_000);

  it('sees a non-owner write committed during the admission’s wait on the run, and sends nothing', async () => {
    const picked = await workedBy('owner', 'Our about page, write during wait');
    const leaseId = String(picked.detail['leaseId']);
    const run = held(w, async (tx) => {
      await tx.query(
        `select 1 from public.planned_runs r join public.leases l
            on l.business_id = r.business_id and l.run_id = r.id
          where l.business_id = $1 and l.id = $2 for update of r`,
        [tx.businessId, leaseId],
      );
    });
    await run.ready;
    const before = sends();
    const answer = ask(picked);
    const waited = await seenWaiting(w, /from public\.planned_runs/u);
    await wrote(picked.taskId, w.world.agentActorId);
    run.release();
    await run.done;
    expect(await answer).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
    expect(waited).toBe(true);
    expect(sends()).toBe(before);
  }, 120_000);
});

describe.skipIf(serverUrl === undefined)('at the agent’s request on our own site', () => {
  it('sees a non-owner write committed during the request’s wait, and stores nothing', async () => {
    const picked = await workedBy('owner', 'Our about page, write during request');
    const holding = held(w, async (tx) => {
      await tx.query(`select 1 from public.records where business_id = $1 and id = $2 for update`, [
        tx.businessId,
        picked.taskId,
      ]);
    });
    await holding.ready;
    const request = requestOwn(picked);
    const waited = await seenWaiting(w, /insert into public\.live_corrections/u);
    await wrote(picked.taskId, w.world.agentActorId);
    holding.release();
    await holding.done;
    expect(codeOf(await request)).toBe('CORRECTION_NOT_OWN_WORK');
    expect(waited).toBe(true);
    expect(await storedOn(picked.taskId)).toBe(0);
  }, 120_000);

  it('sees a non-owner write committed while the request waits on the agent’s own standing, and stores nothing', async () => {
    const picked = await workedBy('owner', 'Our about page, write during standing');
    const holding = held(w, async (tx) => {
      await tx.query(
        'select 1 from public.actors where business_id = $1 and id = $2 for no key update',
        [tx.businessId, w.world.agentActorId],
      );
    });
    await holding.ready;
    const request = requestOwn(picked);
    let waited = false;
    try {
      waited = await seenWaiting(w, /select 1 from public\.actors.*for share/u);
      await wrote(picked.taskId, w.world.agentActorId);
    } finally {
      holding.release();
      await holding.done;
    }
    expect(codeOf(await request)).toBe('CORRECTION_NOT_OWN_WORK');
    expect(waited).toBe(true);
    expect(await storedOn(picked.taskId)).toBe(0);
  }, 120_000);
});

describe.skipIf(serverUrl === undefined)('at a replay of the agent’s request', () => {
  it('gets no stored receipt back from a replay that waited on the audit chain while an agent wrote', async () => {
    const picked = await workedBy('owner', 'Our about page, replay during audit wait');
    const body = ownBody(picked);
    expect(codeOf(await requestOwn(picked, body))).toBe('not-a-refusal');
    const holding = held(w, async (tx) => {
      await advisoryLock(tx, tx.businessId.toLowerCase());
    });
    await holding.ready;
    const request = requestOwn(picked, body);
    let waited = false;
    try {
      waited = await seenWaiting(w, /insert into audit_events/u);
      await wrote(picked.taskId, w.world.agentActorId);
    } finally {
      holding.release();
      await holding.done;
    }
    expect(waited).toBe(true);
    const replayed = await request;
    expect(codeOf(await requestOwn(picked))).toBe('CORRECTION_NOT_OWN_WORK');
    expect(codeOf(replayed)).toBe('CORRECTION_NOT_OWN_WORK');
  }, 120_000);
});

describe.skipIf(serverUrl === undefined)(
  'at a replay of the agent’s request, holding its task',
  () => {
    it('keeps a client set during the replay’s audit-chain wait waiting, and answers as the task stood', async () => {
      const picked = await workedBy('owner', 'Our about page, client during replay wait');
      const body = ownBody(picked);
      expect(codeOf(await requestOwn(picked, body))).toBe('not-a-refusal');
      const holding = held(w, async (tx) => {
        await advisoryLock(tx, tx.businessId.toLowerCase());
      });
      await holding.ready;
      const request = requestOwn(picked, body);
      let setting: Held<unknown> | undefined;
      let waited = false;
      let setWaited = false;
      try {
        waited = await seenWaiting(w, /insert into audit_events/u);
        setting = held(
          w,
          async (tx) =>
            await tx.query(
              `update public.records set uuid_7 = $2::uuid,
                data = data || jsonb_build_object('client', $2::text)
            where business_id = $1 and id = $3`,
              [tx.businessId, w.partyA, picked.taskId],
            ),
        );
        setWaited = await seenWaiting(w, /update public\.records set uuid_7/u);
      } finally {
        holding.release();
        await holding.done;
      }
      expect(waited).toBe(true);
      const replayed = await request;
      await setting?.ready;
      setting?.release();
      await setting?.done;
      expect(setWaited).toBe(true);
      expect(codeOf(replayed)).toBe('not-a-refusal');
    }, 120_000);
  },
);
