// SPDX-License-Identifier: AGPL-3.0-only
//
// T2c1, `task.dispatch` on every surface, against the real served API: the
// command line as its own process, and the HTTP routes it posts to, on the
// agent prefix and the person prefix.
//
// The agent dispatches its picked-up synthetic step through the command line
// and is answered with the marked attempt; the same operation identity sent
// again replays the stored answer. With no committed reservation behind the
// lease, dispatch refuses `BUDGET_UNAVAILABLE` on the agent's command line,
// the agent's HTTP route, the person's command line and the person's HTTP
// route, and marks nothing. No output carries a credential.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, tokenFor, type World } from '../acceptance/world.ts';
import { insertActor, insertLogin, insertMapping, insertPerson } from '../identity/fixture.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { runCli, serveApi, type Run, type ServedApi } from './cli-process-harness.ts';

interface Lease {
  readonly taskId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly reservationId: string;
  readonly credential?: string;
}

/** An answer with its lease id blanked, to compare with a fabricated lease's. */
const shape = (answer: { status: number; body: Record<string, unknown> }, id: string): string =>
  JSON.stringify(answer).replaceAll(id, 'LEASE');

function detailOf(run: Run): Record<string, unknown> {
  const detail = run.json?.['detail'];
  if (typeof detail !== 'object' || detail === null) {
    throw new Error(`no detail: ${String(run.code)} ${run.stdout} ${run.stderr}`);
  }
  return detail as Record<string, unknown>;
}

describe.skipIf(serverUrl === undefined)('T2c1 task.dispatch on every surface', () => {
  let world: World;
  let api: ServedApi | undefined;
  let scratch: string;

  const as = (token: string, extra: Readonly<Record<string, string>> = {}) => ({
    OPS_ASTRO_API_URL: (api as ServedApi).origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: token,
    OPS_ASTRO_TOKEN_FILE: join(scratch, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(scratch, 'delegation'),
    ...extra,
  });

  /** A new task whose step Ada proposed and approved: the create's answer and the reservation. */
  async function approved(kind: string): Promise<{ task: Run; reservationId: string }> {
    const person = as(world.ada.token);
    const task = await runCli(
      ['task.create', '--json', JSON.stringify({ fields: { title: `dispatch ${kind}` } })],
      person,
    );
    const proposed = await runCli(
      [
        'task.propose',
        '--json',
        JSON.stringify({
          recordId: task.json?.['recordId'],
          expectedRevision: task.json?.['revision'],
          purpose: `t2c1_${randomUUID().slice(0, 8)}`,
          maximumMinor: 2_000,
          currency: 'AUD',
          payload: { change: 'a team-only comment' },
          step: { kind, payload: {} },
        }),
      ],
      person,
    );
    const gate = detailOf(proposed);
    const decided = await runCli(
      [
        'task.decide',
        '--json',
        JSON.stringify({
          gateId: gate['gateId'],
          versionId: gate['versionId'],
          decision: 'approve',
          note: 'approved for the dispatch surfaces',
        }),
      ],
      person,
    );
    return { task, reservationId: String(detailOf(decided)['reservationId']) };
  }

  /** Approved work on a new task, picked up by the agent or by Ada herself. */
  async function picked(kind: string, by: 'agent' | 'person'): Promise<Lease> {
    const { task, reservationId } = await approved(kind);
    const file = join(scratch, `delegation-${randomUUID()}`);
    const pickup = await runCli(
      [
        'task.pickup',
        ...(by === 'agent' ? ['--agent'] : []),
        '--json',
        JSON.stringify({ reservationId }),
      ],
      by === 'agent'
        ? as(world.agent.token, { OPS_ASTRO_DELEGATION_FILE: file })
        : as(world.ada.token),
    );
    expect(pickup.code, pickup.stdout).toBe(0);
    const held = detailOf(pickup);
    return {
      taskId: String(task.json?.['recordId']),
      leaseId: String(held['leaseId']),
      fence: Number(held['fence']),
      reservationId,
      ...(by === 'agent' ? { credential: readFileSync(file, 'utf8').trim() } : {}),
    };
  }

  const cliDispatch = async (lease: Lease, operationId = randomUUID()): Promise<Run> =>
    await runCli(
      [
        'task.dispatch',
        '--json',
        JSON.stringify({ operationId, leaseId: lease.leaseId, fence: lease.fence }),
      ],
      lease.credential === undefined
        ? as(world.ada.token)
        : as(world.agent.token, { OPS_ASTRO_AGENT: '1', OPS_ASTRO_DELEGATION: lease.credential }),
    );

  const httpDispatch = async (lease: Lease, operationId = randomUUID(), bearer?: string) => {
    const agent = lease.credential !== undefined && bearer === undefined;
    const response = await fetch(
      `${(api as ServedApi).origin}${agent ? '/api/a/b/' : '/api/b/'}alpha/task/dispatch`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearer ?? (agent ? world.agent.token : world.ada.token)}`,
          ...(agent ? { 'x-agent-delegation': lease.credential as string } : {}),
        },
        body: JSON.stringify({ operationId, leaseId: lease.leaseId, fence: lease.fence }),
      },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const marked = async (lease: Lease): Promise<boolean> =>
    (
      await world.db.admin.execute<{ readonly marked: boolean }>(
        'select dispatch_marker as marked from public.attempts where reservation_id = $1',
        [lease.reservationId],
      )
    )[0]?.marked ?? true;

  const abandon = async (lease: Lease): Promise<void> => {
    await world.db.admin.execute(
      `update public.reservations set state = 'abandoned',
              classified_cause = 'lease_expired_and_fenced', terminal_at = now()
        where id = $1`,
      [lease.reservationId],
    );
  };

  beforeAll(async () => {
    world = await createWorld('t2c1surf');
    scratch = mkdtempSync(join(tmpdir(), 't2c1-surfaces-'));
    api = await serveApi(world);
    await world.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
      [world.alpha],
    );
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await world?.close();
  }, 60_000);

  it('the agent dispatches through the command line, and a replay answers the same', async () => {
    const lease = await picked('synthetic_comment', 'agent');
    const operationId = randomUUID();
    const run = await cliDispatch(lease, operationId);
    expect(run.code, run.stdout).toBe(0);
    expect(detailOf(run)).toMatchObject({ leaseId: lease.leaseId, reconcileMode: 'replay' });
    expect(run.stdout).not.toContain(lease.credential);
    expect(run.stderr).not.toContain(lease.credential);
    expect(await marked(lease)).toBe(true);
    const again = await httpDispatch(lease, operationId);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body['detail']).toStrictEqual(run.json?.['detail']);
  }, 60_000);

  it('refuses BUDGET_UNAVAILABLE with no committed reservation, on every surface', async () => {
    const leases = [
      await picked('synthetic_comment', 'agent'),
      await picked('synthetic_comment', 'agent'),
      await picked('synthetic_comment', 'person'),
      await picked('synthetic_comment', 'person'),
    ];
    for (const lease of leases) {
      // eslint-disable-next-line no-await-in-loop
      await abandon(lease);
    }
    const [agentCli, agentHttp, personCli, personHttp] = leases as [Lease, Lease, Lease, Lease];
    for (const run of [await cliDispatch(agentCli), await cliDispatch(personCli)]) {
      expect(run.code, run.stdout).toBe(1);
      expect(run.json).toMatchObject({ refused: true, code: 'BUDGET_UNAVAILABLE' });
    }
    for (const answer of [await httpDispatch(agentHttp), await httpDispatch(personHttp)]) {
      expect(answer.body, JSON.stringify(answer.body)).toMatchObject({
        code: 'BUDGET_UNAVAILABLE',
      });
    }
    for (const lease of leases) {
      // eslint-disable-next-line no-await-in-loop
      expect(await marked(lease)).toBe(false);
    }
  }, 120_000);
  /** A client outside the business: a login and a person, standing on the one task Ada shares. */
  async function client(taskId: string): Promise<string> {
    const subject = `t2c1-client-${randomUUID()}`;
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      const personId = await insertPerson(tx, 'a client');
      await insertActor(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, String(world.ada.actorId));
      const sharer = { personId: String(world.ada.personId), actorId: String(world.ada.actorId) };
      const shared = await shareRecord(tx, sharer, {
        collection: 'task',
        recordId: taskId,
        personId,
      });
      if (!shared.ok) throw new Error(`share refused ${shared.refusal.code}`);
    });
    return await tokenFor(subject);
  }

  it('T2 isolation: client to client, task.dispatch', async () => {
    // Ada's own lease on the task she shares with one client; another client stands on another task.
    const lease = await picked('synthetic_comment', 'person');
    const other = await picked('synthetic_comment', 'person');
    const own = await client(lease.taskId);
    const stranger = await client(other.taskId);
    for (const token of [own, stranger]) {
      const made = randomUUID();
      // eslint-disable-next-line no-await-in-loop
      const answer = await httpDispatch(lease, randomUUID(), token);
      // eslint-disable-next-line no-await-in-loop
      const invented = await httpDispatch({ ...lease, leaseId: made }, randomUUID(), token);
      expect(answer.status, JSON.stringify(answer.body)).not.toBe(200);
      expect(answer.body['refused'] ?? answer.body['code']).toBeTruthy();
      expect(shape(answer, lease.leaseId)).toBe(shape(invented, made));
    }
    expect(await marked(lease)).toBe(false);
    expect(await marked(other)).toBe(false);
  }, 120_000);

  it('T2 isolation: person to person, task.dispatch', async () => {
    // Mia holds write across the business, and Ada's lease is still not hers to dispatch.
    const lease = await picked('synthetic_comment', 'person');
    const made = randomUUID();
    const answer = await httpDispatch(lease, randomUUID(), world.mia.token);
    const invented = await httpDispatch({ ...lease, leaseId: made }, randomUUID(), world.mia.token);
    expect(answer.status, JSON.stringify(answer.body)).toBe(403);
    expect(answer.body).toMatchObject({ refused: true, code: 'LEASE_NOT_OWNED' });
    expect(shape(answer, lease.leaseId)).toBe(shape(invented, made));
    expect(await marked(lease)).toBe(false);
  }, 60_000);
});
