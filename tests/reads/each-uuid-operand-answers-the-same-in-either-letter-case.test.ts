// SPDX-License-Identifier: AGPL-3.0-only
//
// A uuid operand is one id in either letter case, in every read and slot. Each
// (read, `id` operand) in `READ_OPERANDS` is a case: a row of this business
// answers alike in both spellings, and a made-up id and another business's id
// are refused alike and never echoed. A read this world cannot seed cheaply gets
// the refusals only (`REFUSAL_ONLY` says why); a new `id` operand with no case
// fails the first test.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { ReadRequest } from '../../packages/core-commands/src/reads/requests.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  READ_OPERANDS,
  type ReadBody,
  type ReadOperands,
} from '../../packages/core-wire/src/read-operands.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { foreignConversation } from '../acceptance/foreign-conversation.ts';
import { clientHere } from './client-rows.ts';
import {
  alpha,
  bravo,
  bravoOwner,
  clientAViewer,
  command,
  db,
  ids,
  owner,
  revisionOf,
  serverUrl,
  setUp,
  tearDown,
} from './rank-world.ts';

type Body = Readonly<Record<string, unknown>>;

/** Every (read, `id` operand) pair, across every form of the read's body. */
const GENERATED: readonly string[] = Object.entries(READ_OPERANDS).flatMap(([read, body]) => {
  const forms =
    'oneOf' in (body as ReadBody)
      ? (body as { oneOf: readonly ReadOperands[] }).oneOf
      : [body as ReadOperands];
  const names = new Set(
    forms.flatMap((form) =>
      Object.entries(form)
        .filter(
          ([, operand]) =>
            typeof operand === 'string' && /^id(?:\?|\|null|\?\|null)?$/u.test(operand),
        )
        .map(([name]) => name),
    ),
  );
  return [...names].toSorted().map((name) => `${read} ${name}`);
});

/** The world's rows, filled once the database is up. */
const row: Record<string, string> = {};
const at = (name: string) => () => {
  const id = row[name] ?? ids[name];
  if (id === undefined) throw new Error(`The world has no ${name}`);
  return id;
};

interface Case {
  /** The request with this operand at `id`; every other operand as the lowercase request sends it. */
  readonly body: (id: string) => Body;
  /** A row of this business the operand names; none for a refusal-only case. */
  readonly seeded?: () => string;
  /** A row of another business, or failing one of its kind, another business's task. */
  readonly foreign: () => string;
  /** The answer to an id that names nothing, when it is not a refusal. */
  readonly miss?: Body;
  readonly hit?: (id: string) => Body;
}

/** A case whose request is `extra` and this one operand; `seeded` and `foreign` name rows. */
const one = (
  read: string,
  operand: string,
  seeded: string | null,
  foreign: string,
  extra: Body = {},
): Case => ({
  body: (id) => ({ read, ...extra, [operand]: id }),
  ...(seeded === null ? {} : { seeded: at(seeded) }),
  foreign: at(foreign),
});

const CASES: Readonly<Record<string, Case>> = {
  'map.view recordId': one('map.view', 'recordId', 'map', 'bravo'),
  'map.frontier recordId': one('map.frontier', 'recordId', 'map', 'bravo'),
  'conversation.read conversationId': one(
    'conversation.read',
    'conversationId',
    'conversation',
    'bravoConversation',
  ),
  'conversation.allowance conversationId': one(
    'conversation.allowance',
    'conversationId',
    'conversation',
    'bravoConversation',
  ),
  'conversation.models conversationId': one(
    'conversation.models',
    'conversationId',
    'conversation',
    'bravoConversation',
  ),
  'task.read recordId': one('task.read', 'recordId', 'a504', 'bravo'),
  'task.read historyEventId': {
    body: (historyEventId) => ({
      read: 'task.read',
      recordId: at('a504')(),
      detail: 'full',
      historyEventId,
    }),
    seeded: at('event'),
    foreign: at('bravoEvent'),
    // The task is there, so the entry missing is null, not a refusal (U116).
    miss: { ok: true, view: { historyEvent: null } },
    hit: (eventId) => ({ ok: true, view: { historyEvent: { eventId } } }),
  },
  'task.board board': one('task.board', 'board', 'board', 'bravo'),
  'task.board person': one('task.board', 'person', 'owner', 'bravoOwner', { mode: 'aggregate' }),
  'task.board client': one('task.board', 'client', 'client', 'bravoClient', { mode: 'aggregate' }),
  'task.todos person': one('task.todos', 'person', 'owner', 'bravoOwner'),
  'task.todos client': one('task.todos', 'client', 'client', 'bravoClient'),
  'task.execution recordId': one('task.execution', 'recordId', 'a504', 'bravo'),
  'task.receipt attemptId': one('task.receipt', 'attemptId', null, 'bravo'),
  'privacy.draft_breach_notices incidentId': one(
    'privacy.draft_breach_notices',
    'incidentId',
    null,
    'bravo',
    {
      oaic: { name: 'A made-up regulator', address: 'regulator@example.test' },
      people: [{ name: 'A made-up person', address: 'person@example.test' }],
      containment: 'Nothing real happened.',
      steps: 'Nothing to do.',
    },
  ),
  'chat.messages conversationId': one(
    'chat.messages',
    'conversationId',
    'chat',
    'bravoConversation',
  ),
  'trace.read recordId': one('trace.read', 'recordId', 'a504', 'bravo'),
  'harness.read runId': one('harness.read', 'runId', null, 'bravo'),
  'live_correction.read correctionId': one('live_correction.read', 'correctionId', null, 'bravo'),
};

/** The cases with no row in this world, each with its reason: they get the refusal cases only. */
const REFUSAL_ONLY: Readonly<Record<string, string>> = {
  'task.receipt attemptId': 'an attempt needs a run on a task, which this world does not start',
  'privacy.draft_breach_notices incidentId': 'an incident needs a published breach runbook first',
  'harness.read runId': 'a harness result needs an agent run, which this world does not start',
  'live_correction.read correctionId': 'a correction needs a client site and a version of it',
};

it('every uuid operand a read takes has a case here, run or refusal-only with a reason', () => {
  expect(GENERATED.length).toBeGreaterThan(0);
  expect(Object.keys(CASES).toSorted()).toStrictEqual([...GENERATED].toSorted());
  for (const key of GENERATED) {
    expect(CASES[key]?.seeded === undefined, key).toBe(key in REFUSAL_ONLY);
  }
});

const ask = async (body: Body) =>
  await executeRead(db.app, alpha, owner.presented, body as unknown as ReadRequest);

/** A made-up uuid with a letter in it, so its uppercase spelling differs. */
const madeUp = (): string => {
  const id = randomUUID();
  return /[a-f]/u.test(id) ? id : madeUp();
};

/** The lowercase request and its uppercase twin answer alike; the twin really differs. */
async function twins(key: string, id: string): ReturnType<typeof ask> {
  const { body } = CASES[key] as Case;
  const lower = id.toLowerCase();
  expect(lower.toUpperCase(), `${key}: ${id} has no letter to turn`).not.toBe(lower);
  const answer = await ask(body(lower));
  expect(await ask(body(lower.toUpperCase())), key).toStrictEqual(answer);
  return answer;
}

/** The keys these reads ask, so a refusal comes from the lookup and not the door. */
async function grantTheReads(): Promise<void> {
  await db.app.withBusiness(alpha, async (tx) => {
    const keys = [
      ['read', 'operations'],
      ['comment', 'chat'],
      ['write', 'conversation'],
      ['manage', 'privacy'],
      ['write', 'run'],
      ['read', 'person'],
      ['assign', 'task'],
    ] as const;
    for (const [action, collection] of keys) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, owner, action, WHOLE_BUSINESS, false, collection);
    }
    await grantTo(tx, clientAViewer, 'comment', WHOLE_BUSINESS, false, 'chat');
  });
}

/** The id of a task's scores entry in its history. */
const eventOf = async (recordId: string): Promise<string> =>
  (
    await db.admin.execute<{ readonly id: string }>(
      `select id::text from public.audit_events where subject_record_id = $1
         and command = 'task.set_scores' and outcome = 'applied'`,
      [recordId],
    )
  )[0]?.id ?? '';

/** A task the owner creates. */
const create = async (body: Body) =>
  (await command(alpha, owner, { command: 'task.create', ...body })).recordId ?? '';

/** The owner's write on a task at its current revision. */
const revise = async (recordId: string, name: string, fields: Body) =>
  await command(alpha, owner, {
    command: name,
    recordId,
    expectedRevision: await revisionOf(recordId),
    fields,
  });

/** A row of each kind the cases name, in this business and in the other. */
async function seedRows(): Promise<void> {
  row['owner'] = owner.personId;
  row['bravoOwner'] = bravoOwner.personId;
  row['client'] = await clientHere(db.admin, alpha, madeUp());
  // The owner's own task, on a board and under the sweep's client, so each scope lists a row.
  row['board'] = await create({ fields: { title: 'a board' } });
  const mine = await create({ board: row['board'], fields: { title: 'mine' } });
  await revise(mine, 'task.set_party', { client: row['client'] });
  await revise(mine, 'task.assign', { assignee: owner.personId });
  row['bravoClient'] = await clientHere(db.admin, bravo, madeUp());
  const map = await command(alpha, owner, {
    command: 'map.chart',
    title: 'the sweep’s map',
    destination: 'one spelling',
    tickets: [{ ref: 'a', title: 'a ticket', type: 'task' }],
    fog: ['a fog line'],
  });
  row['map'] = map.recordId ?? '';
  const sent = await command(alpha, owner, {
    command: 'chat.send_direct',
    teammateId: clientAViewer.personId,
    body: 'hello',
  });
  row['chat'] = String(sent.detail['conversationId']);
  const [conversation] = await db.admin.execute<{ readonly id: string }>(
    `insert into public.conversations (business_id, id, owner_actor_id, owner_person_id, title)
     values ($1, $2, $3, $4, 'the sweep’s conversation') returning id::text`,
    [alpha, madeUp(), owner.actorId, owner.personId],
  );
  row['conversation'] = conversation?.id ?? '';
  row['bravoConversation'] = await foreignConversation(db.admin, bravo);
  row['event'] = await eventOf(at('a504')());
  row['bravoEvent'] = await eventOf(at('bravo')());
}

describe.skipIf(serverUrl === undefined)('each uuid operand, in either letter case', () => {
  beforeAll(async () => {
    await setUp();
    await grantTheReads();
    await seedRows();
  }, 180_000);
  afterAll(async () => {
    await tearDown();
  });
  const seedable = Object.keys(CASES).filter((key) => !(key in REFUSAL_ONLY));

  it.each(seedable)('%s: a seeded row answers alike in either case', async (key) => {
    const { seeded, hit } = CASES[key] as Case;
    const answer = await twins(key, seeded?.() ?? '');
    expect(isCommandRefusal(answer), `${key}: ${JSON.stringify(answer)}`).toBe(false);
    if (hit !== undefined) expect(answer, key).toMatchObject(hit(seeded?.() ?? ''));
  });

  it.each(Object.keys(CASES))('%s: made-up and foreign ids answer alike, unechoed', async (key) => {
    const { foreign, miss } = CASES[key] as Case;
    for (const id of [madeUp(), foreign()]) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time reads as a list
      const answer = await twins(key, id);
      if (miss === undefined)
        expect(isCommandRefusal(answer), `${key}: ${JSON.stringify(answer)}`).toBe(true);
      else expect(answer, key).toMatchObject(miss);
      expect(JSON.stringify(answer).toLowerCase(), key).not.toContain(id.toLowerCase());
    }
  });
});
