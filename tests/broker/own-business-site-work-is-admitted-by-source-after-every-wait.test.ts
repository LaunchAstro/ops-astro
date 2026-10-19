// SPDX-License-Identifier: AGPL-3.0-only
//
// R6, part 2 (#1699): the broker, the source rule and the correction request
// agree on part 1's one binding (#1688). An owner-started task with no client
// takes the owner's subscription for work on the business's own site and its
// agent requests the correction there, through the real broker, custody and
// the replay provider. A client's task is refused before any send. A task a
// client typed on, or an agent wrote, or staff started keeps its text off the
// subscription, and its agent cannot request on the business's own site.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { CLOUD, LOCAL } from './broker-world.ts';
import {
  ask,
  clientContact,
  freeText,
  movesTo,
  ownBody,
  requestOwn,
  SEAT,
  sends,
  serverUrl,
  storedOn,
  useOwnSiteWorld,
  w,
  workedBy,
  wrote,
} from './own-site-broker-world.ts';

if (serverUrl === undefined)
  console.warn('Own-business site work by source: DATABASE_URL is unset, so nothing ran.');

useOwnSiteWorld('own1699');

describe.skipIf(serverUrl === undefined)("the owner's own internal work", () => {
  it("drafts a correction on the business's own site through the broker on the owner's subscription", async () => {
    const picked = await workedBy('owner', 'Our about page');
    const before = sends();
    const answer = await ask(picked);
    expect(answer).toMatchObject({ ok: true });
    const [call] = await w.world.db.admin.execute<Record<string, unknown>>(
      'select state, credential_kind from public.model_calls where id = $1',
      [answer.callId],
    );
    expect(call).toEqual({ state: 'settled', credential_kind: 'subscription' });
    expect(sends()).toBe(before + 1);
    const asked = await requestOwn(picked);
    expect(codeOf(asked)).toBe('not-a-refusal');
    const [row] = await w.world.db.admin.execute<Record<string, unknown>>(
      `select party_id, state, requested_by_actor_id::text as actor
         from public.live_corrections where id = $1`,
      [detailOf(asked)['correctionId']],
    );
    expect(row).toEqual({ party_id: null, state: 'locating', actor: w.world.agentActorId });
  }, 120_000);

  it('keeps a client-typed field local on the same task', async () => {
    const picked = await workedBy('owner', 'Our about page, a client note');
    const before = sends();
    const answer = await ask(picked, [
      ...freeText(picked.taskId),
      { name: 'note', value: 'typed by a client', source: 'client_person' },
    ]);
    expect(answer).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
    expect(sends()).toBe(before);
  }, 120_000);
});

describe.skipIf(serverUrl === undefined)("a real client's task", () => {
  it('is refused SUBSCRIPTION_NOT_FOR_CLIENT_WORK before any send, and cannot request on our site', async () => {
    await movesTo(w.ava.personId, 'owner');
    const picked = await w.pickUpUnder(w.ava, `client work ${randomUUID().slice(0, 6)}`, w.partyA);
    const before = sends();
    for (const routes of [[SEAT], [LOCAL, CLOUD, SEAT]]) {
      // oxlint-disable-next-line no-await-in-loop -- one route set after the other
      const answer = await ask(picked, freeText(picked.taskId), routes);
      expect(answer).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK' });
    }
    expect(sends()).toBe(before);
    expect(codeOf(await requestOwn(picked))).toBe('NOT_FOUND');
    expect(await storedOn(picked.taskId)).toBe(0);
  }, 120_000);
});

describe.skipIf(serverUrl === undefined)(
  'an own-business task that is not the owner’s own work',
  () => {
    it.each([
      [
        'a client contact typed on it',
        async (taskId: string) => await wrote(taskId, await clientContact()),
      ],
      ['an agent wrote on it', async (taskId: string) => await wrote(taskId, w.world.agentActorId)],
    ])(
      'loses the subscription and the own-site request when %s',
      async (_how, touch) => {
        const picked = await workedBy('owner', 'Our about page, touched');
        await touch(picked.taskId);
        const before = sends();
        expect(await ask(picked)).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
        expect(sends()).toBe(before);
        expect(codeOf(await requestOwn(picked))).toBe('CORRECTION_NOT_OWN_WORK');
        expect(await storedOn(picked.taskId)).toBe(0);
      },
      120_000,
    );

    it('gets no stored receipt back on a replay once an agent has written on the task', async () => {
      const picked = await workedBy('owner', 'Our about page, replayed');
      const body = ownBody(picked);
      expect(codeOf(await requestOwn(picked, body))).toBe('not-a-refusal');
      await wrote(picked.taskId, w.world.agentActorId);
      expect(codeOf(await requestOwn(picked))).toBe('CORRECTION_NOT_OWN_WORK');
      expect(codeOf(await requestOwn(picked, body))).toBe('CORRECTION_NOT_OWN_WORK');
    }, 120_000);

    it('started by staff, cannot request on the business’s own site', async () => {
      const picked = await workedBy('member', 'Our about page, staff');
      expect(codeOf(await requestOwn(picked))).toBe('CORRECTION_NOT_OWN_WORK');
      expect(await storedOn(picked.taskId)).toBe(0);
    }, 120_000);
  },
);
