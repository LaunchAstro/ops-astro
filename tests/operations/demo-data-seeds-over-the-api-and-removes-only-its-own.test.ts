// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite on one composed API, its cases in order */
//
// The demo data (scripts/ops/demo-data.ts, #2211, register 253) against the
// composed API: seeded as one person through the product's commands, every
// step in the operation register, each task in its state, a stop and a rerun
// making nothing twice, and removal trashing the manifest's tasks and nothing
// real, refusing a manifest that names a real task.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createCli } from '../../apps/cli/client.ts';
import { createApiFixture, BUSINESS_KEY, tokenFor, type ApiFixture } from '../api/fixture.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import {
  CLIENTS,
  MAX_CEILING_MINOR,
  NEEDED,
  remove,
  seed,
  TASKS,
  THREADS,
  type Manifest,
  type Send,
} from '../../scripts/ops/demo-data.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('demo data over the API', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let send: Send;
  let realTask = '';
  const realClient = 'Acme Real Client';
  const manifest: Manifest = {
    version: 1,
    batch: randomUUID().slice(0, 12),
    business: BUSINESS_KEY,
    api: 'http://api.test',
    createdAt: '2026-10-20T06:00:00.000Z',
    made: [],
  };
  const query = async <Row>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<readonly Row[]> =>
    await fixture.db.admin.execute<Row>(text, [fixture.business, ...values]);
  const tasksTitled = async (): Promise<number> =>
    Number(
      (
        await query<{ n: string }>(
          `select count(*)::text as n from public.records r join public.record_types t
              on t.business_id = r.business_id and t.id = r.record_type_id
            where r.business_id = $1 and t.key = 'task' and r.txt_4 like 'Demo %'`,
        )
      )[0]?.n,
    );

  beforeAll(async () => {
    fixture = await createApiFixture('demodata');
    api = fixture.compose();
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      // The owner's grants the run checks for, beyond the fixture's own task pairs.
      const fixtures = new Set(
        ['read', 'write', 'decide', 'assign', 'comment'].map((a) => `task:${a}`),
      );
      for (const pair of NEEDED.filter((p) => !fixtures.has(p))) {
        const [collection = '', action] = pair.split(':') as [string, Action];
        // Sequential: `issueGrant` reads the granter's own rows.
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, fixture.member, action, WHOLE_BUSINESS, false, collection);
      }
    });
    const credential = await tokenFor(fixture.member.presented.subject, {
      secondFactor: true,
      expiresIn: 3600,
    });
    const cli = createCli({
      transport: async (path, body, bearer) =>
        await api.fetch(
          new Request(`http://api.test${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
            body,
          }),
        ),
      businessKey: BUSINESS_KEY,
      credential,
    });
    send = async (verb, body) => {
      const answer = await cli.run(verb, body);
      return { status: answer.status, body: answer.body };
    };
    // The business's real work, which the demo must leave as it is.
    const client = await cli.run('client.create', { operationId: randomUUID(), name: realClient });
    expect(client.status).toBe(200);
    const task = await cli.run('task.create', {
      operationId: randomUUID(),
      fields: { title: 'Real task' },
    });
    expect(task.status).toBe(200);
    realTask = String((task.body as Record<string, unknown>)['recordId']);
  }, 180_000);

  afterAll(async () => await fixture?.drop());

  it('a run stopped part way and run again makes every demo record once, each through the register', async () => {
    let saves = 0;
    // The first run stops after its twentieth step, as a lost connection would.
    await expect(
      seed(send, manifest, () => {
        saves += 1;
        if (saves === 20) throw new Error('stopped');
      }),
    ).rejects.toThrow('stopped');
    const atStop = manifest.made.length;
    // The twentieth step's answer was never saved: the rerun sends it again and it replays.
    manifest.made.pop();
    await seed(send, manifest, () => {});
    expect(manifest.made.length).toBeGreaterThan(atStop);
    expect(await tasksTitled()).toBe(TASKS.length);

    const count = (kind: string): number => manifest.made.filter((m) => m.kind === kind).length;
    expect([count('client'), count('tag'), count('task'), count('thread')]).toStrictEqual([
      CLIENTS.length,
      1,
      TASKS.length,
      THREADS.length,
    ]);
    expect(count('proposal')).toBe(TASKS.filter((t) => t.plan !== undefined).length);
    expect(count('comment')).toBe(TASKS.reduce((n, t) => n + (t.comments?.length ?? 0), 0));

    // A third run makes nothing.
    expect(await seed(send, manifest, () => {})).toStrictEqual([]);
    expect(await tasksTitled()).toBe(TASKS.length);

    // Every step went through the command register, as the signed-in person.
    const registered = await query<{ operation_id: string; actor_id: string }>(
      `select operation_id, actor_id from public.operations
        where business_id = $1 and operation_id like $2`,
      [`demo-data:${manifest.batch}:%`],
    );
    const steps = new Set(registered.map((r) => r.operation_id));
    for (const made of manifest.made)
      expect(steps.has(`demo-data:${manifest.batch}:${made.step}`)).toBe(true);
    expect(new Set(registered.map((r) => r.actor_id))).toStrictEqual(
      new Set([fixture.member.actorId]),
    );
  });

  it('each demo record is named Demo, each task sits in its state, and budgets stay at AUD 5 or less', async () => {
    const clients = await query<{ id: string; name: string }>(
      `select id, name from public.clients where business_id = $1`,
    );
    const ours = new Set(manifest.made.filter((m) => m.kind === 'client').map((m) => m.id));
    expect(
      clients
        .filter((c) => ours.has(c.id))
        .map((c) => c.name)
        .toSorted(),
    ).toStrictEqual([...CLIENTS].toSorted());
    expect(clients.map((c) => c.name)).toContain(realClient);

    const states = await query<{
      title: string;
      state: string;
      category: string;
      client: string | null;
    }>(
      `select r.txt_4 as title, s.txt_1 as state, s.txt_2 as category, r.uuid_7::text as client
         from public.records r join public.records s on s.business_id = r.business_id and s.id = r.uuid_1
        where r.business_id = $1 and r.txt_4 like 'Demo %'`,
    );
    const byTitle = new Map(states.map((s) => [s.title, s]));
    const category = {
      new: 'unstarted',
      planned: 'unstarted',
      waiting_on_review: 'unstarted',
      accepted: 'unstarted',
      in_progress: 'started',
      waiting_on_client: 'started',
      on_hold: 'backlog',
      done: 'completed',
    };
    for (const task of TASKS) {
      expect(byTitle.get(task.title)?.category, task.title).toBe(category[task.end]);
      expect(byTitle.get(task.title)?.client !== null, task.title).toBe(task.client !== null);
    }

    const gates = await query<{ title: string; state: string; ceiling: string }>(
      `select r.txt_4 as title, g.state, v.maximum_minor::text as ceiling
         from public.gates g
         join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
         join public.planned_runs run on run.business_id = g.business_id and run.id = g.run_id
         join public.records r on r.business_id = run.business_id and r.id = run.task_id
        where g.business_id = $1`,
    );
    const pending = TASKS.filter((t) => t.end === 'waiting_on_review')
      .map((t) => t.title)
      .toSorted();
    const approved = TASKS.filter((t) => t.end === 'accepted').map((t) => t.title);
    expect(
      gates
        .filter((g) => g.state === 'pending')
        .map((g) => g.title)
        .toSorted(),
    ).toStrictEqual(pending);
    expect(gates.filter((g) => g.state !== 'pending').map((g) => g.title)).toStrictEqual(approved);
    for (const gate of gates) expect(Number(gate.ceiling)).toBeLessThanOrEqual(MAX_CEILING_MINOR);

    // Nothing reached anyone but the person who ran it: no inbox item for another person.
    const recipients = await query<{ person: string }>(
      `select distinct recipient_person_id::text as person from public.inbox_items where business_id = $1`,
    );
    for (const row of recipients) expect(row.person).toBe(fixture.member.personId);
  });

  it('a decision chain broken outside the run leaves the accepted task unreadable, as on staging', async () => {
    // One signed payload altered as the owner, triggers off for the statement alone
    // (tests/tenancy/wrapper-mutation.test.ts): every later case removes past the break.
    await fixture.db.admin.execute('alter table public.gate_decisions disable trigger all');
    try {
      await query(
        `update public.gate_decisions
            set payload = jsonb_set(payload, '{note}', '"approved for something else"')
          where business_id = $1`,
      );
    } finally {
      await fixture.db.admin.execute('alter table public.gate_decisions enable trigger all');
    }
    const accepted = manifest.made.find(
      (m) => m.kind === 'task' && m.name === TASKS.find((t) => t.end === 'accepted')?.title,
    );
    const read = await send('task.read', { recordId: String(accepted?.id) });
    expect([read.status, (read.body as Record<string, unknown>)['code']]).toStrictEqual([
      500,
      'DECISION_INTEGRITY',
    ]);
  });

  it('removal refuses a manifest naming a real task, and touches nothing first', async () => {
    const tampered: Manifest = {
      ...manifest,
      // Last, so a removal that trashed as it read would have trashed every demo task first.
      made: [
        ...manifest.made,
        { step: 'task:x', kind: 'task', id: realTask, name: 'Demo Real task' },
      ],
    };
    await expect(remove(send, tampered)).rejects.toThrow("titled 'Real task'");
    const live = await query<{ n: string }>(
      `select count(*)::text as n from public.records where business_id = $1 and txt_4 like 'Demo %'
          and deleted_at is null`,
    );
    expect(Number(live[0]?.n)).toBe(TASKS.length);
  });

  it('removal trashes every demo task and no real one, past a broken chain, and a second removal sends no trash', async () => {
    expect(await remove(send, manifest)).toStrictEqual({ trashed: TASKS.length, gone: 0 });
    const rows = await query<{ title: string; deleted: boolean }>(
      `select txt_4 as title, deleted_at is not null as deleted from public.records
        where business_id = $1 and (txt_4 like 'Demo %' or id = $2)`,
      [realTask],
    );
    expect(
      rows
        .filter((r) => r.deleted)
        .map((r) => r.title)
        .toSorted(),
    ).toStrictEqual(TASKS.map((t) => t.title).toSorted());
    expect(rows.find((r) => r.title === 'Real task')?.deleted).toBe(false);
    expect(await remove(send, manifest)).toStrictEqual({ trashed: 0, gone: TASKS.length });
  });
});
