// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-10 (#470) on a real database: a person sets their own availability
// with a reason (CS-7.27, `availability set`, audited), on the person prefix
// only (their own account; no agent holds it), and the Team panel's people
// strip reads it through `team.list`, staff only. Every change is one row
// and one audit event in one transaction; a refusal writes neither.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { composeApi } from '../../apps/api/server.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { ISSUER, SECRET, authorised, post, tokenFor, type Answer } from './fixture.ts';
import { delegatedRead } from './c4-live-support.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { createTask, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { cq8World } from '../runtime/cq-8-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('api/mp-7-10-availability: DATABASE_URL is unset.');

let s: Schedules;
let key: string;
let api: Hono;

const keyOf = async (business: string): Promise<string> => {
  const rows = await s.db.admin.execute<{ key: string }>(
    'select key from public.businesses where id = $1',
    [business],
  );
  return String(rows[0]?.key);
};

/** A member of this business who may list its people. */
const teammate = async (): Promise<Member> => {
  const who = await enrol(s.db.app, s.business, `mp710-${randomUUID().slice(0, 8)}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, who, 'read', undefined, false, 'person');
  });
  return who;
};

const setAvailability = async (who: Member, body: unknown, at = key): Promise<Answer> =>
  await post(api, `${PREFIX.person}${at}/account/availability`, body, {
    ...authorised(await tokenFor(who.presented.subject)),
  });

const teamList = async (who: Member, at = key): Promise<Answer> =>
  await post(
    api,
    `${PREFIX.person}${at}/team/list`,
    {},
    {
      ...authorised(await tokenFor(who.presented.subject)),
    },
  );

interface Listed {
  readonly personId: string;
  readonly name: string;
  readonly availability: { readonly state: string; readonly reason: string | null } | null;
}

const listed = (answer: Answer): Listed[] => answer.body['people'] as Listed[];
const entryOf = (answer: Answer, who: Member): Listed | undefined =>
  listed(answer).find((person) => person.personId === who.personId);

/** Every row and audit event availability has written, for this business. */
const written = async (business = s.business) => {
  const rows = await s.db.admin.execute<{
    person_id: string;
    state: string;
    reason: string | null;
  }>('select person_id, state, reason from public.person_availability where business_id = $1', [
    business,
  ]);
  const events = await s.db.admin.execute<{ actor_id: string; outcome: string; hash: string }>(
    `select actor_id, outcome, hash from public.audit_events
      where business_id = $1 and command = 'availability.set' order by seq`,
    [business],
  );
  return { rows, events };
};

/** MP-7-10 CS-7.27: the person sets their own availability with a reason */
async function setsOwn(): Promise<void> {
  const me = await teammate();
  const set = await setAvailability(me, { state: 'away', reason: 'At the dentist until 2' });
  expect(set.status).toBe(200);
  expect(set.body['availability']).toMatchObject({
    state: 'away',
    reason: 'At the dentist until 2',
  });
  const back = await setAvailability(me, { state: 'available' });
  expect([back.status, back.body['availability']]).toEqual([
    200,
    { state: 'available', reason: null },
  ]);
  const mine = (await written()).rows.filter((row) => row.person_id === me.personId);
  expect(mine).toEqual([{ person_id: me.personId, state: 'available', reason: null }]);
}

/** MP-7-10 people strip with away state as a word: a teammate lists the person as away, with the reason */
async function strip(): Promise<void> {
  const me = await teammate();
  const mate = await teammate();
  expect(entryOf(await teamList(mate), me)).toEqual({
    personId: me.personId,
    name: expect.any(String),
    availability: null,
  });
  await setAvailability(me, { state: 'away', reason: 'Out on a shoot' });
  expect(entryOf(await teamList(mate), me)?.availability).toEqual({
    state: 'away',
    reason: 'Out on a shoot',
  });
}

/** MP-7-10 every change is recorded: availability set writes its row and joins the audit chain in one transaction */
async function recorded(): Promise<void> {
  const me = await teammate();
  const before = (await written()).events.length;
  await setAvailability(me, { state: 'away', reason: 'Lunch' });
  const { events } = await written();
  expect(events).toHaveLength(before + 1);
  expect(events.at(-1)).toMatchObject({ actor_id: me.actorId, outcome: 'applied' });
  expect(events.at(-1)?.hash).toMatch(/^[0-9a-f]{64}$/u);
}

/** MP-7-10 availability set refuses undeclared fields, a bad state and an over-long reason, writing nothing */
async function refusals(): Promise<void> {
  const me = await teammate();
  const before = await written();
  const bodies: unknown[] = [
    { state: 'asleep' },
    { state: 'away', reason: 'x'.repeat(141) },
    { state: 'away', reason: 7 },
    { state: 'available', reason: 'still here' },
    { state: 'away', personId: s.decider.personId },
    {},
  ];
  for (const body of bodies) {
    // eslint-disable-next-line no-await-in-loop -- each body in turn.
    const answer = await setAvailability(me, body);
    expect([answer.status, answer.body['refused']]).toEqual([422, true]);
  }
  const agent = await post(api, `${PREFIX.agent}${key}/account/availability`, { state: 'away' });
  expect(agent.status).toBe(404);
  expect(await written()).toEqual(before);
}

/** MP-7-10 isolation: another business, another client and a person under a delegation */
async function isolation(): Promise<void> {
  const me = await teammate();
  await setAvailability(me, { state: 'away', reason: 'Canary reason 5f1e' });
  const world = cq8World(s);
  // Another business: refused at our key, and its own list names nobody of ours.
  const other = await world.party(`mp710-${randomUUID().slice(0, 8)}`);
  const otherKey = await keyOf(other.id);
  await s.db.app.withBusiness(other.id, async (tx) => {
    await grantTo(tx, other.member, 'read', undefined, false, 'person');
  });
  const theirs = await teamList(other.member, otherKey);
  expect(theirs.status).toBe(200);
  expect(JSON.stringify(theirs.body)).not.toContain(me.personId);
  expect(JSON.stringify(theirs.body)).not.toContain('Canary reason');
  for (const answer of [
    await teamList(other.member),
    await setAvailability(other.member, { state: 'away' }),
  ]) {
    expect([answer.status, JSON.stringify(answer.body).includes('Canary')]).toEqual([403, false]);
  }
  expect((await written(other.id)).rows).toEqual([]);
  // Two clients of this business, each on a shared task: the Team panel is staff only.
  const taskId = await createTask(s, `mp710-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'share'));
  const clientCrossing = async (name: string): Promise<void> => {
    const client = await world.client(s.business, s.decider, name, taskId);
    const answers = [await teamList(client), await setAvailability(client, { state: 'away' })];
    expect(answers.map((a) => [a.status, JSON.stringify(a.body).includes(me.personId)])).toEqual([
      [404, false],
      [404, false],
    ]);
  };
  await clientCrossing('mp710-client-1');
  await clientCrossing('mp710-client-2');
  // A person under a live delegation from me sets their own row and never mine.
  const delegate = await teammate();
  await s.db.app.withBusiness(
    s.business,
    async (tx) => await delegatedRead(tx, me, delegate, taskId),
  );
  expect((await setAvailability(delegate, { state: 'away', reason: 'Theirs' })).status).toBe(200);
  const rows = (await written()).rows.filter((row) =>
    [me.personId, delegate.personId].includes(row.person_id),
  );
  expect(rows.toSorted((a, b) => a.reason?.localeCompare(b.reason ?? '') ?? 0)).toEqual([
    { person_id: me.personId, state: 'away', reason: 'Canary reason 5f1e' },
    { person_id: delegate.personId, state: 'away', reason: 'Theirs' },
  ]);
}

describe.skipIf(serverUrl === undefined)('MP-7-10 availability and the team list', () => {
  beforeAll(async () => {
    s = await openSchedules('mp710', 1_000_000);
    key = await keyOf(s.business);
    api = composeApi({
      database: s.db.app,
      admin: s.db.admin,
      secret: SECRET,
      issuer: ISSUER,
      keys: runtimeKeys({ ...process.env }),
    }).app;
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('MP-7-10 CS-7.27: the person sets their own availability with a reason', setsOwn);
  it(
    'MP-7-10 people strip with away state as a word: a teammate lists the person as away, with the reason',
    strip,
  );
  it(
    'MP-7-10 every change is recorded: availability set writes its row and joins the audit chain in one transaction',
    recorded,
  );
  it(
    'MP-7-10 availability set refuses undeclared fields, a bad state and an over-long reason, writing nothing',
    refusals,
  );
  it(
    'MP-7-10 isolation: another business, another client and a person under a delegation',
    isolation,
  );
});
