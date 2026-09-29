// SPDX-License-Identifier: AGPL-3.0-only
//
// C23 isolation: the person menu's read and its sign-out cross nothing, over
// the real HTTP route of the role-case harness. Three crossings, statuses
// checked and every body read whole, refusals included:
//
//  - another business: bravo's member, asking under alpha, is refused naming
//    nobody, and nothing is recorded as a sign-out of anyone in alpha; ada's
//    own sign-out lands on alpha's chain and never on bravo's;
//  - another client in the same business: two people, each holding read on
//    one client's task only, are each answered with their own name, never the
//    other's, and a sign-out naming the other is refused and ends nobody;
//  - another person under a live delegation: the agent is refused both, the
//    body names nobody, and the delegating person is still signed in.

// Sequential on purpose: each call is one caller's, read back before the next.
// oxlint-disable no-await-in-loop

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { enrolCaller, type Caller } from '../acceptance/cast.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import type { CommandName } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const END: CommandName = 'session.end';
const PERSON: CommandName = 'session.person';

type Body = Readonly<Record<string, unknown>>;

const nameOf = (body: Body): string =>
  String((body['person'] as Readonly<Record<string, unknown>> | undefined)?.['name']);

// eslint-disable-next-line max-lines-per-function -- one world, the three crossings
describe.skipIf(databaseUrlFromEnvironment() === undefined)('C23 isolation', () => {
  let harness: Harness;
  let adaName: string;
  let miaName: string;
  let beaName: string;
  /** Two people of alpha, each holding read on one client's task only. */
  let cleo: Caller;
  let dora: Caller;

  const signOuts = async (business: 'alpha' | 'bravo', actorId: string): Promise<string[]> => {
    const rows = await harness.world.db.admin.execute<{ readonly outcome: string }>(
      `select outcome from public.audit_events
        where business_id = $1 and command = 'session.end' and actor_id = $2 order by seq`,
      [business === 'alpha' ? harness.world.alpha : harness.world.bravo, actorId],
    );
    return rows.map((row) => row.outcome);
  };

  beforeAll(async () => {
    harness = await createHarness('c23iso');
    const { world } = harness;
    adaName = nameOf((await harness.asPerson(PERSON, {})).body);
    miaName = nameOf((await harness.asPerson(PERSON, {}, 'alpha', world.mia)).body);
    beaName = nameOf((await harness.asPerson(PERSON, {}, 'bravo', world.bea)).body);
    const other = await harness.asPerson('task.create', { fields: { title: 'Dora client task' } });
    const clientTasks = [harness.alphaTask.id, String(other.body['recordId'])];
    const none = { membership: true, actions: [], collections: [] } as const;
    cleo = await enrolCaller(world.db, world.alpha, 'alpha', 'cleo', none);
    dora = await enrolCaller(world.db, world.alpha, 'alpha', 'dora', none);
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      for (const [who, task] of [
        [cleo, clientTasks[0]],
        [dora, clientTasks[1]],
      ] as const) {
        await grantTo(tx, who as unknown as Member, 'read', { kind: 'record', id: String(task) });
      }
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('each person is answered with their own name', () => {
    expect(new Set([adaName, miaName, beaName]).size).toBe(3);
    for (const name of [adaName, miaName, beaName]) expect(name).not.toBe('undefined');
  });

  it('another business: bravo’s member is refused under alpha, naming nobody, and ends nobody', async () => {
    const { world } = harness;
    const alphaBefore = await signOuts('alpha', String(world.ada.actorId));
    for (const name of [PERSON, END]) {
      const answer = await harness.asPerson(name, {}, 'alpha', world.bea);
      const body = JSON.stringify(answer.body);
      expect(answer.status, name).toBe(403);
      expect(answer.body['code'], name).toBe('AUTH_NO_MEMBERSHIP');
      expect(body, name).not.toContain(adaName);
      expect(body, name).not.toContain(miaName);
      expect(body, name).not.toContain(String(world.ada.personId));
    }
    expect(await signOuts('alpha', String(world.bea.actorId))).toEqual([]);
    expect(await signOuts('alpha', String(world.ada.actorId))).toEqual(alphaBefore);
    // And ada's own sign-out lands in alpha only.
    const own = await harness.asPerson(END, {});
    expect(own.status).toBe(200);
    expect((await signOuts('alpha', String(world.ada.actorId))).at(-1)).toBe('applied');
    expect(await signOuts('bravo', String(world.ada.actorId))).toEqual([]);
  });

  it('another client in the same business: one client’s person is answered as themselves and cannot end the other', async () => {
    const mine = await harness.asPerson(PERSON, {}, 'alpha', cleo);
    expect(mine.status).toBe(200);
    const cleoName = nameOf(mine.body);
    expect(mine.body).toEqual({ ok: true, person: { name: cleoName } });
    const doraName = nameOf((await harness.asPerson(PERSON, {}, 'alpha', dora)).body);
    expect(doraName).not.toBe(cleoName);
    const body = JSON.stringify(mine.body);
    for (const other of [doraName, String(dora.personId), 'Dora client task']) {
      expect(body).not.toContain(other);
    }
    for (const naming of [
      { personId: dora.personId },
      { actorId: dora.actorId },
      { accountId: dora.personId },
    ]) {
      const answer = await harness.asPerson(END, naming, 'alpha', cleo);
      expect(answer.body['refused'], JSON.stringify(naming)).toBe(true);
      expect(JSON.stringify(answer.body)).not.toContain(String(dora.personId));
      expect(JSON.stringify(answer.body)).not.toContain(doraName);
    }
    expect(await signOuts('alpha', String(dora.actorId))).toEqual([]);
    // Dora is still signed in: her own read still answers.
    expect((await harness.asPerson(PERSON, {}, 'alpha', dora)).status).toBe(200);
    // Cleo's own sign-out records Cleo and nobody else.
    expect((await harness.asPerson(END, {}, 'alpha', cleo)).status).toBe(200);
    expect((await signOuts('alpha', String(cleo.actorId))).at(-1)).toBe('applied');
    expect(await signOuts('alpha', String(dora.actorId))).toEqual([]);
  });

  it('another person under a live delegation: the agent is refused both and the person is still signed in', async () => {
    const { world } = harness;
    const { decided } = await harness.approvedReservation();
    const detail = decided.body['detail'] as Readonly<Record<string, unknown>>;
    const picked = await harness.asAgent('task.pickup', {
      reservationId: String(detail['reservationId']),
    });
    const credential = String((picked.body['detail'] as Body)['credential']);
    const adaBefore = await signOuts('alpha', String(world.ada.actorId));
    for (const name of [PERSON, END]) {
      for (const asked of [credential, undefined]) {
        const answer = await harness.asAgent(name, {}, asked);
        const body = JSON.stringify(answer.body);
        expect(answer.body['refused'], name).toBe(true);
        expect(answer.status, name).toBeGreaterThanOrEqual(400);
        expect(body, name).not.toContain(adaName);
        expect(body, name).not.toContain(String(world.ada.personId));
      }
    }
    // Every attempt is on the chain, so the agent's are there, each refused.
    const agentAttempts = await signOuts('alpha', String(world.agent.actorId));
    expect(agentAttempts.length).toBeGreaterThan(0);
    expect(agentAttempts.every((outcome) => outcome === 'refused')).toBe(true);
    expect(await signOuts('alpha', String(world.ada.actorId))).toEqual(adaBefore);
    expect((await harness.asPerson(PERSON, {})).status).toBe(200);
  });
});
