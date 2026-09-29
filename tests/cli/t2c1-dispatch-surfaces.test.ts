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
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type Run, type ServedApi } from './cli-process-harness.ts';

interface Lease {
  readonly leaseId: string;
  readonly fence: number;
  readonly reservationId: string;
  readonly credential?: string;
}

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

  /** Approved work on a new task, picked up by the agent or by Ada herself. */
  async function picked(kind: string, by: 'agent' | 'person'): Promise<Lease> {
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
    const reservationId = String(detailOf(decided)['reservationId']);
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

  const httpDispatch = async (lease: Lease, operationId = randomUUID()) => {
    const agent = lease.credential !== undefined;
    const response = await fetch(
      `${(api as ServedApi).origin}${agent ? '/api/a/b/' : '/api/b/'}alpha/task/dispatch`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${agent ? world.agent.token : world.ada.token}`,
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
});
