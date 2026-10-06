// SPDX-License-Identifier: AGPL-3.0-only
//
// What the agent cost reads count and what they refuse, in money minor units
// per run. A call released on proof that nothing happened is a known zero,
// never an open call. A client-scoped reader sees that client's runs as the
// client view shows its tasks: never one on a map's ticket or a trashed task.
// A record-scoped grant is no reading scope; a key either read does not take
// and a period with no zone are refused; the cost log answers a bounded number
// of rows.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { AgentCostsResult, SkillCostsResult } from '../../packages/core-wire/src/index.ts';
import { listRunCosts } from '../../packages/core-records/src/index.ts';
import { createCostWorld, type CostWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const DAY = 24 * 60 * 60 * 1000;

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('what the cost reads count and refuse', () => {
  let w: CostWorld;
  let clientA: string;
  let recordReader: Member;
  const runs = { released: '', shown: '', ticket: '', trashed: '' };
  const period = () => ({
    from: new Date(Date.now() - DAY).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
  });

  const agentCosts = async (who: Member, body: object = period()): Promise<AgentCostsResult> => {
    const answer = await w.read(who, 'finance.agent_costs', body);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body as unknown as AgentCostsResult;
  };

  const owner = async (sql: string, parameters: readonly unknown[]): Promise<void> => {
    await w.controls.fixture.db.admin.execute(sql, parameters);
  };

  beforeAll(async () => {
    w = await createCostWorld('costguards');
    clientA = await w.client('Client A');
    const { db } = w.controls.fixture;
    await db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, w.clientReader, 'read', { kind: 'party', id: clientA }, false, 'finance');
    });
    runs.released = (
      await w.run({
        calls: [
          { state: 'settled', minor: 30 },
          { state: 'released' },
          { state: 'settled', minor: 12 },
        ],
      })
    ).runId;
    const shown = await w.run({ client: clientA, calls: [{ state: 'settled', minor: 50 }] });
    runs.shown = shown.runId;
    const ticket = await w.run({ client: clientA, calls: [{ state: 'settled', minor: 400 }] });
    runs.ticket = ticket.runId;
    const trashed = await w.run({ client: clientA, calls: [{ state: 'settled', minor: 600 }] });
    runs.trashed = trashed.runId;
    // A map, and the ticket's task filed under it; the trashed task in the trash.
    const map = await w.controls.createTask('the map');
    await owner(`update public.records set data = data || '{"type":"map"}'::jsonb where id = $1`, [
      map.id,
    ]);
    await owner(
      `update public.records set data = data || jsonb_build_object('parent', $2::text)
        where id = $1`,
      [ticket.taskId, map.id],
    );
    await owner(
      `update public.records
          set deleted_at = now(), deleted_by_actor_id = $2, trash_batch_id = $3
        where id = $1`,
      [trashed.taskId, w.controls.manager.actorId, randomUUID()],
    );
    recordReader = await enrol(db.app, w.alpha, 'recordfinance');
    await db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(
        tx,
        recordReader,
        'read',
        { kind: 'record', id: shown.taskId },
        false,
        'finance',
      );
    });
  }, 300_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('a released call is a known zero: its run is priced at its settled calls', async () => {
    const result = await agentCosts(w.finance);
    const row = result.runs.find((one) => one.runId === runs.released);
    expect(row).toMatchObject({ cost: '42', unpriced: null });
    const skills = await w.read(w.finance, 'finance.skill_costs', {});
    const split = (skills.body as unknown as SkillCostsResult).costing?.split[0];
    expect(split?.unpricedRuns).toBe(0);
  });

  it('a client-scoped reader never sees a run on a map’s ticket or a trashed task, in rows or totals', async () => {
    const result = await agentCosts(w.clientReader);
    expect(result.runs.map((one) => one.runId)).toStrictEqual([runs.shown]);
    expect(result.byAgent.map((one) => [one.runs, one.total])).toStrictEqual([[1, '50']]);
    expect(result.byAttachment.map((one) => [one.runs, one.total])).toStrictEqual([[1, '50']]);
    const text = JSON.stringify(result);
    for (const id of [runs.ticket, runs.trashed]) expect(text).not.toContain(id);
    const skills = await w.read(w.clientReader, 'finance.skill_costs', {});
    const split = (skills.body as unknown as SkillCostsResult).costing?.split;
    expect(split?.map((one) => [one.runs, one.total])).toStrictEqual([[1, '50']]);
  });

  it('a business-wide reader still sees the runs on a map’s ticket and a trashed task', async () => {
    const result = await agentCosts(w.finance);
    const ids = result.runs.map((one) => one.runId);
    for (const id of [runs.ticket, runs.trashed]) expect(ids).toContain(id);
  });

  it('a caller whose only finance:read grant is on one record is refused, not answered empty', async () => {
    for (const [name, body] of [
      ['finance.agent_costs', period()],
      ['finance.skill_costs', {}],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const answer = await w.read(recordReader, name, body);
      expect(answer.status, JSON.stringify(answer.body)).toBe(403);
      expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
    }
  });

  it('a key the read does not take is refused, never ignored', async () => {
    for (const [name, body] of [
      ['finance.agent_costs', { ...period(), currency: 'USD' }],
      ['finance.skill_costs', { currency: 'USD' }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const answer = await w.read(w.finance, name, body);
      expect(answer.status, JSON.stringify(answer.body)).toBe(400);
      expect(answer.body['code']).toBe('COMMAND_BODY_INVALID');
      expect(answer.body['names']).toStrictEqual(['currency']);
    }
  });

  it('a period with no zone is refused: from and to carry Z or an offset', async () => {
    const zoned = period();
    for (const [body, field] of [
      [{ from: zoned.from.slice(0, 16), to: zoned.to }, 'from'],
      [{ from: zoned.from, to: zoned.to.replace('Z', '') }, 'to'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one body at a time
      const answer = await w.read(w.finance, 'finance.agent_costs', body);
      expect(answer.status, JSON.stringify(answer.body)).toBe(422);
      expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
      expect(answer.body['names']).toStrictEqual([field]);
    }
    const offset = await agentCosts(w.finance, {
      from: '2000-01-01T10:00:00+10:00',
      to: '2000-06-01T00:00:00Z',
    });
    expect(offset.period.from).toBe('2000-01-01T00:00:00.000Z');
  });

  it('the cost log is bounded: its statement returns one row past the bound, so more is known', async () => {
    const business = [{ kind: 'business', id: null }] as const;
    const bounded = await w.controls.fixture.db.app.withBusiness(
      w.alpha,
      async (tx) => await listRunCosts(tx, business, { from: null, to: null, rows: 2 }),
    );
    expect(bounded).toHaveLength(3);
    const long = await agentCosts(w.finance, {
      from: '2026-01-01T00:00:00.000Z',
      to: '2100-01-01T00:00:00.000Z',
    });
    expect(long.runs).toHaveLength(4);
  });
});
