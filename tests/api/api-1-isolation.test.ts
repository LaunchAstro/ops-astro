// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1 isolation, against the real boundary and a fresh Postgres: for every
// command in the catalogue, the CLI and the API answer a caller exactly as the
// app's own client does, so no surface reads a row, or skips a grant, the app
// refuses. Two businesses, Alpha and Bravo, and in Alpha two tasks standing for
// two clients' work, each with one person holding one grant on it alone; and
// an agent working under a live delegation from another person, which reaches
// only the task it picked up, never a second Alpha person's own held reservation
// or live lease. Made-up names only.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { buildCatalogue, type CatalogueRow } from '../../packages/core-wire/src/index.ts';
import { createCli } from '../../apps/cli/client.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { authorised, createApiFixture, post, tokenFor, type ApiFixture } from './fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Heard {
  readonly status: number;
  readonly code: unknown;
  /** The whole answer, each known record id and title replaced by its label. */
  readonly body: unknown;
}

type Name = 'client1' | 'client2' | 'bravo' | 'other';
/** Whose delegated work a task, title, lease or reservation is: the agent's own, or the second Alpha person's. */
type Owner = 'delegated' | 'other';

/** Every task, title, lease, reservation, business or person any answer names, refusals included, but the caller's own. */
function foreign(heard: readonly Heard[], own: Name | null): string[] {
  const named = heard
    .flatMap((one) =>
      Array.from(
        JSON.stringify(one.body).matchAll(
          /<(client1|client2|bravo|other) (?:task|title|lease|reservation|business|person)>/gu,
        ),
      ),
    )
    .map((match) => match[1] as string);
  return [...new Set(named)].filter((name) => name !== own);
}

/** Refused by the body's shape is not refused by a grant or delegation: these prove nothing. */
const SHAPE = ['COMMAND_BODY_INVALID', 'FIELD_VALUE_INVALID', 'OPERATION_ID_REQUIRED'];

const detail = (body: Record<string, unknown>): Record<string, unknown> =>
  body['detail'] as Record<string, unknown>;

/** One answer as text with its keys sorted: the CLI re-serialises what it heard. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) =>
    field !== null && typeof field === 'object' && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).toSorted(([a], [b]) => a.localeCompare(b)))
      : field,
  );

it('a refusal carrying another client record is detected', () => {
  const refused: Heard[] = [
    { status: 403, code: 'SCOPE_NOT_GRANTED', body: { recordId: '<client2 task>' } },
  ];
  expect(foreign(refused, 'client1')).toEqual(['client2']);
});

describe.skipIf(serverUrl === undefined)('API-1 isolation', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let rows: CatalogueRow[];
  const task: Record<'alpha' | 'client1' | 'client2' | 'bravo', string> = {
    alpha: '',
    client1: '',
    client2: '',
    bravo: '',
  };
  let clientOne: Member;
  let clientTwo: Member;
  let bravoBusinessId: string;
  /** The agent's own login, and the delegation its pickup minted for one task. */
  let agentToken: string;
  let delegation: string;
  let delegatedTask: string;
  /** A second Alpha person's own claims: one approved and held, one picked up and live. */
  let foreignLease: { leaseId: string; fence: unknown };
  let foreignReservation: string;
  let foreignPersonId = '';
  let foreignTaskId = '';
  let attemptedForeignLeaseId = '';
  let attemptedForeignReservationId = '';
  /** Raw id or title to its label, so a leak is named and no record value is printed. */
  const labels = new Map<string, string>();

  function label(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value ?? null), (_key, field: unknown) =>
      typeof field === 'string'
        ? [...labels].reduce((text, [raw, name]) => text.replaceAll(raw, name), field)
        : field,
    );
  }

  const through = ((url: string | URL, init?: RequestInit) =>
    api.fetch(new Request(`http://api.test${String(url)}`, init))) as typeof fetch;

  async function create(businessKey: string, token: string, name: Name): Promise<string> {
    const title = `made-up ${name} ${randomUUID()}`;
    const answer = await post(
      api,
      `/api/b/${businessKey}/task/create`,
      { operationId: randomUUID(), fields: { title } },
      authorised(token),
    );
    const id = (answer.body as { recordId?: string }).recordId;
    if (answer.status !== 200 || typeof id !== 'string') throw new Error(JSON.stringify(answer));
    labels.set(id, `<${name} task>`).set(title, `<${name} title>`);
    return id;
  }

  beforeAll(async () => {
    fixture = await createApiFixture('api_1_isolation');
    api = fixture.compose();
    rows = buildCatalogue([]);
    const bravo = await insertBusiness(fixture.db.app, 'bravo');
    bravoBusinessId = bravo;
    await installSpine(fixture.db.app, bravo);
    const bravoWriter = await enrol(fixture.db.app, bravo, 'bravo-writer');
    labels.set(bravo, '<bravo business>');
    labels.set(bravoWriter.personId, '<bravo person>').set(bravoWriter.actorId, '<bravo person>');
    await fixture.db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, bravoWriter, 'read');
      await grantTo(tx, bravoWriter, 'write');
    });
    const alphaToken = await tokenFor(fixture.member.presented.subject);
    task.client1 = await create('alpha', alphaToken, 'client1');
    task.client2 = await create('alpha', alphaToken, 'client2');
    task.bravo = await create('bravo', await tokenFor(bravoWriter.presented.subject), 'bravo');
    clientOne = await enrol(fixture.db.app, fixture.business, 'client-one-person');
    clientTwo = await enrol(fixture.db.app, fixture.business, 'client-two-person');
    for (const [member, name] of [
      [clientOne, 'client1'],
      [clientTwo, 'client2'],
    ] as const) {
      labels.set(member.personId, `<${name} person>`).set(member.actorId, `<${name} person>`);
    }
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, clientOne, 'read', { kind: 'record', id: task.client1 });
      await grantTo(tx, clientTwo, 'read', { kind: 'record', id: task.client2 });
    });
    ({ agentToken, delegation, delegatedTask } = await pickUp(alphaToken, 'delegated'));
    const otherPerson = await enrol(fixture.db.app, fixture.business, 'other-decider');
    foreignPersonId = otherPerson.personId;
    labels.set(otherPerson.personId, '<other person>').set(otherPerson.actorId, '<other person>');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
        // eslint-disable-next-line no-await-in-loop -- `issueGrant` reads the granter's own rows
        await grantTo(tx, otherPerson, action);
      }
    });
    const otherToken = await tokenFor(otherPerson.presented.subject);
    // Their held reservation, for the agent's own purpose; and their live lease, held
    // by a second agent under their delegation for that same purpose, so only the
    // delegation's one task tells the two agents' leases apart.
    foreignReservation = await approve(otherToken, 'other');
    const secondAgent = `agent-${randomUUID()}`;
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      const actorId = randomUUID();
      await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
        fixture.business,
        actorId,
      ]);
      await tx.query(
        `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
         values ($1, $2, $3, $4, $5)`,
        [
          fixture.business,
          randomUUID(),
          await insertLogin(tx, secondAgent),
          actorId,
          otherPerson.actorId,
        ],
      );
    });
    const theirs = await pickUp(otherToken, 'other', secondAgent);
    foreignTaskId = theirs.delegatedTask;
    foreignLease = { leaseId: theirs.leaseId, fence: theirs.fence };
  }, 120_000);

  /** An Alpha person proposes and approves one task: its reservation, held for pickup. */
  async function approve(personToken: string, owner: Owner): Promise<string> {
    const asPerson = async (path: string, body: Record<string, unknown>) =>
      (await post(api, `/api/b/alpha${path}`, body, authorised(personToken))).body;
    const title = `made-up ${owner} ${randomUUID()}`;
    const made = await asPerson('/task/create', { operationId: randomUUID(), fields: { title } });
    labels.set(String(made['recordId']), `<${owner} task>`).set(title, `<${owner} title>`);
    const proposed = await asPerson('/task/propose', {
      operationId: randomUUID(),
      recordId: made['recordId'],
      expectedRevision: made['revision'],
      purpose: 'api_1_isolation',
      maximumMinor: 2_500,
      currency: 'AUD',
      payload: { instruction: 'draft a made-up reply' },
      step: { kind: 'compose', payload: { tone: 'plain' } },
    });
    const decided = await asPerson('/task/decide', {
      operationId: randomUUID(),
      gateId: detail(proposed)['gateId'],
      versionId: detail(proposed)['versionId'],
      decision: 'approve',
      note: 'approved for the API-1 delegation crossing',
    });
    const reservationId = detail(decided)['reservationId'];
    if (typeof reservationId !== 'string') throw new Error(JSON.stringify(decided));
    labels.set(reservationId, `<${owner} reservation>`);
    return reservationId;
  }

  /** An Alpha person approves one task, and an agent picks it up under that person's delegation. */
  async function pickUp(personToken: string, owner: Owner, agentSubject = fixture.agent.subject) {
    const token = await tokenFor(agentSubject);
    const picked = await post(
      api,
      '/api/a/b/alpha/task/pickup',
      { operationId: randomUUID(), reservationId: await approve(personToken, owner) },
      authorised(token),
    );
    if (picked.status !== 200) throw new Error(JSON.stringify(picked));
    const taskId = String(detail(picked.body)['taskId']);
    labels.set(taskId, `<${owner} task>`);
    const held = detail(picked.body);
    const leaseId = String(held['leaseId']);
    labels.set(leaseId, `<${owner} lease>`);
    return {
      agentToken: token,
      delegation: String(held['credential']),
      delegatedTask: taskId,
      leaseId,
      fence: held['fence'],
    };
  }

  afterAll(async () => await fixture?.drop());

  /** One command through the app's client, the CLI and the API, as one caller. */
  async function threeWays(
    row: CatalogueRow,
    member: Member,
    businessKey: string,
    body: Record<string, unknown>,
  ): Promise<Heard[]> {
    const token = await tokenFor(member.presented.subject);
    const heard: Heard[] = [];
    const recording = (async (url: string | URL, init?: RequestInit) => {
      const response = await through(url, init);
      const parsed = (await response
        .clone()
        .json()
        .catch(() => ({}))) as { code?: unknown } | null;
      heard.push({ status: response.status, code: parsed?.code, body: label(parsed) });
      return response;
    }) as typeof fetch;
    const app = new OperationsClient({ origin: '', businessKey, token, fetch: recording });
    const operationId = randomUUID();
    await (row.kind === 'read'
      ? app.read(row.command as never, body)
      : app.mutate(row.command as never, body, { operationId, expectedRevision: 1 }));
    const payload = row.kind === 'read' ? body : { ...body, operationId, expectedRevision: 1 };
    const cli = createCli({
      businessKey,
      credential: token,
      transport: async (path, sent, credential) =>
        await recording(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
          body: sent,
        }),
    });
    await cli.run(row.command, payload);
    await recording(row.api.person.replace(':businessKey', businessKey), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    return heard;
  }

  /** One command as the agent under its delegation, through the CLI and the API's agent route. */
  async function asAgent(
    row: CatalogueRow,
    businessKey: string,
    body: Record<string, unknown>,
  ): Promise<Heard[]> {
    const heard: Heard[] = [];
    const recording = async (path: string, init: RequestInit) => {
      const response = await through(path, init);
      const parsed = (await response
        .clone()
        .json()
        .catch(() => ({}))) as { code?: unknown } | null;
      heard.push({ status: response.status, code: parsed?.code, body: label(parsed) });
      return response;
    };
    // The agent prefix takes an operation id on every call, reads included.
    const payload = {
      ...body,
      operationId: randomUUID(),
      ...(row.kind === 'write' && 'recordId' in body ? { expectedRevision: 1 } : {}),
    };
    const cli = createCli({
      businessKey,
      credential: agentToken,
      entry: 'agent',
      delegation,
      transport: async (path, sent, credential, held) =>
        await recording(path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${credential}`,
            ...(held === undefined ? {} : { 'x-agent-delegation': held }),
          },
          body: sent,
        }),
    });
    await cli.run(row.command, payload);
    await recording(String(row.api.agent).replace(':businessKey', businessKey), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${agentToken}`,
        'x-agent-delegation': delegation,
      },
      body: JSON.stringify(payload),
    });
    return heard;
  }

  it('API-1 isolation: business to business, every command answers the same refusal on every surface', async () => {
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time reads as a list
      const heard = await threeWays(row, fixture.member, 'bravo', { recordId: task.bravo });
      expect(heard, row.command).toHaveLength(3);
      expect(new Set(heard.map((one) => JSON.stringify(one))).size, row.command).toBe(1);
      expect(heard[0]?.status, row.command).toBeGreaterThanOrEqual(400);
      expect(foreign(heard, null), row.command).toEqual([]);
    }
  }, 60_000);

  it('API-1 isolation: client to client, a grant on one task reads nothing of the other on any surface', async () => {
    const reads = rows.filter(
      (row) => row.kind === 'read' && row.command === ('task.read' as CommandName),
    );
    for (const [member, own, other, name] of [
      [clientOne, task.client1, task.client2, 'client1'],
      [clientTwo, task.client2, task.client1, 'client2'],
    ] as const) {
      for (const row of reads) {
        // eslint-disable-next-line no-await-in-loop -- each person in turn
        const allowed = await threeWays(row, member, 'alpha', { recordId: own });
        expect(allowed.map((one) => one.status)).toEqual([200, 200, 200]);
        expect(new Set(allowed.map((one) => JSON.stringify(one))).size).toBe(1);
        expect(JSON.stringify(allowed[0]?.body)).toContain(`<${name} task>`);
        expect(foreign(allowed, name)).toEqual([]);
        // eslint-disable-next-line no-await-in-loop -- each person in turn
        const refused = await threeWays(row, member, 'alpha', { recordId: other });
        expect(new Set(refused.map((one) => JSON.stringify(one))).size).toBe(1);
        expect(refused[0]?.status).toBeGreaterThanOrEqual(400);
      }
    }
    // And every write, as the person holding read alone on their own task: refused alike everywhere.
    for (const row of rows.filter((one) => one.kind === 'write')) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time reads as a list
      const heard = await threeWays(row, clientOne, 'alpha', { recordId: task.client2 });
      expect(new Set(heard.map((one) => JSON.stringify(one))).size, row.command).toBe(1);
      expect(heard[0]?.status, row.command).toBeGreaterThanOrEqual(400);
      expect(foreign(heard, 'client1'), row.command).toEqual([]);
    }
  }, 60_000);

  it('API-1 isolation: person to person under a live delegation, the agent reaches only its delegated task', async () => {
    const agentRows = rows.filter((row) => row.api.agent !== null);
    const read = agentRows.find((row) => row.command === 'task.read') as CatalogueRow;
    const own = await asAgent(read, 'alpha', { recordId: delegatedTask });
    expect(own.map((one) => one.status)).toEqual([200, 200]);
    expect(JSON.stringify(own[0]?.body)).toContain('<delegated task>');
    // Each command's own target: a record, a lease, a reservation, or none. A lease
    // call names its task through its lease and ignores a record id beside it, so its
    // crossing is another Alpha person's live lease at its own fence (the same agent
    // holds it, under that person's delegation, not this one); a pickup's crossing is
    // that person's approved reservation, still held.
    const notOwnLease = foreignLease;
    attemptedForeignLeaseId = notOwnLease.leaseId;
    attemptedForeignReservationId = foreignReservation;
    const claims = async () =>
      await fixture.db.admin.execute(
        `select l.state, l.fence::text, l.expires_at::text, r.state as reservation, r.lease_id
           from public.leases l, public.reservations r
          where l.business_id = $1 and l.id = $2 and r.business_id = $1 and r.id = $3`,
        [fixture.business, foreignLease.leaseId, foreignReservation],
      );
    const before = await claims();
    expect(before).toHaveLength(1);
    const target: Record<string, (record: string) => Record<string, unknown> | null> = {
      'task.read': (record) => ({ recordId: record }),
      'task.comment': (record) => ({ recordId: record, body: 'made-up', audience: 'internal' }),
      'task.heartbeat': () => ({ ...notOwnLease, leaseSeconds: 60 }),
      'task.handback': () => ({
        ...notOwnLease,
        outcome: 'completed',
        report: { wrote: 'made-up' },
      }),
      'task.pickup': () => ({ reservationId: attemptedForeignReservationId }),
      'task.queue': () => null,
      'session.capabilities': () => null,
    };
    expect(Object.keys(target).toSorted()).toEqual(agentRows.map((row) => row.command).toSorted());
    // The lease: the delegation's one task is not the other lease's. The pickup: one live
    // delegation per agent and purpose, so a second task never joins the first one's reach.
    const reason: Record<string, string> = {
      'task.heartbeat': 'DELEGATION_OUT_OF_PURPOSE',
      'task.handback': 'DELEGATION_OUT_OF_PURPOSE',
      'task.pickup': 'DELEGATION_ALREADY_LIVE',
    };
    for (const row of agentRows) {
      for (const [businessKey, other] of [
        ['alpha', task.client1],
        ['alpha', task.client2],
        ['bravo', task.bravo],
      ] as const) {
        const body = target[row.command]?.(other) ?? {};
        // eslint-disable-next-line no-await-in-loop -- one command at a time reads as a list
        const heard = await asAgent(row, businessKey, body);
        const where = `${row.command} on ${businessKey}`;
        expect(heard, where).toHaveLength(2);
        expect(
          new Set(heard.map((one) => canonical(one))).size,
          `${where} ${JSON.stringify(heard)}`,
        ).toBe(1);
        // The queue is the business's outstanding work, which any agent login may read by
        // contract (agent-envelope.ts; minimum contract 8.2 case 9): the other person's
        // queued work shows there as ids, purpose and amount, never their title or their
        // person, and nothing of another business or client. Every other answer names none.
        const queued = row.command === 'task.queue' && businessKey === 'alpha';
        expect(foreign(heard, null), where).toEqual(queued ? ['other'] : []);
        if (queued) {
          const seen = JSON.stringify(heard);
          expect(seen, where).toContain('<other reservation>');
          expect(seen, where).not.toMatch(/<other (?:title|person|lease)>|<delegated title>/u);
        }
        if (target[row.command]?.(other) === null && businessKey === 'alpha') {
          expect(heard[0]?.status, where).toBe(200);
          continue;
        }
        expect(heard[0]?.status, where).toBeGreaterThanOrEqual(400);
        expect(SHAPE, where).not.toContain(heard[0]?.code);
        // Refused for the delegation's reason, not because the claim does not exist.
        if (businessKey === 'alpha' && row.command in reason) {
          expect(heard[0]?.code, where).toBe(reason[row.command]);
        }
      }
    }
    // Check first, then act: every refusal left the other person's claims as they were.
    expect(await claims()).toEqual(before);
  }, 60_000);

  it("agent crossings use another person's live lease and held reservation", async () => {
    const leases = await fixture.db.admin.execute<{ person_id: string }>(
      `select authorised_by_person_id::text as person_id
         from public.leases where business_id = $1 and id = $2 and state = 'live'`,
      [fixture.business, attemptedForeignLeaseId],
    );
    expect
      .soft(leases[0]?.person_id, 'the heartbeat and handback target must be a live lease')
      .toBeDefined();
    expect(leases[0]?.person_id).not.toBe(fixture.member.personId);

    const reservations = await fixture.db.admin.execute<{ person_id: string }>(
      `select d.decided_by_person_id::text as person_id
         from public.reservations r
         join public.gate_decisions d on d.business_id = r.business_id and d.version_id = r.version_id
        where r.business_id = $1 and r.id = $2 and r.state = 'held' and r.lease_id is null`,
      [fixture.business, attemptedForeignReservationId],
    );
    expect
      .soft(
        reservations[0]?.person_id,
        "the pickup target must be another person's held reservation",
      )
      .toBeDefined();
    expect(reservations[0]?.person_id).not.toBe(fixture.member.personId);
  });

  it("another person's identifiers remain detectable", () => {
    const refused: Heard[] = [
      {
        status: 403,
        code: 'DELEGATION_OUT_OF_PURPOSE',
        body: label({ personId: foreignPersonId, recordId: foreignTaskId }),
      },
    ];
    expect.soft(foreign(refused, null)).toContain('other');
    expect.soft(label(foreignTaskId)).not.toEqual(label(delegatedTask));
  });

  it('API-1 isolation: a successful read carrying the other client record is caught', async () => {
    const row = rows.find((one) => one.command === 'task.read') as CatalogueRow;
    const leaked = vi
      .spyOn(api, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(Response.json({ recordId: task.client2, fields: { title: 'x' } })),
      );
    try {
      const heard = await threeWays(row, clientOne, 'alpha', { recordId: task.client1 });
      expect(heard.map((one) => one.status)).toEqual([200, 200, 200]);
      expect(foreign(heard, 'client1')).toEqual(['client2']);
    } finally {
      leaked.mockRestore();
    }
  });

  it('isolation sees leaked client data in successful reads', async () => {
    const row = rows.find((one) => one.command === 'task.read');
    if (row === undefined) throw new Error('task.read is missing from the catalogue');
    const leaked = vi
      .spyOn(api, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ recordId: task.client2, fields: { title: 'other client secret' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
    try {
      const heard = await threeWays(row, clientOne, 'alpha', { recordId: task.client1 });
      expect(heard).toHaveLength(3);
      expect(heard[0]).toHaveProperty('body');
      expect(JSON.stringify(heard)).not.toContain(task.client2);
    } finally {
      leaked.mockRestore();
    }
  });

  it('refusals expose no foreign business or person record', () => {
    const heard: Heard[] = [
      {
        status: 403,
        code: 'SCOPE_NOT_GRANTED',
        body: label({ businessId: bravoBusinessId, personId: clientTwo.personId }),
      },
    ];
    expect(foreign(heard, 'client1')).toEqual(['bravo', 'client2']);
  });
});
