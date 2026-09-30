// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-14-6: what our agents cost us, the data half (U39, #489), in money minor
// units per run (ORCH37 on the SL13 ask): the cost log for a period, one row
// per run and agent, and spend per agent and per client taken from those same
// rows. A run without a client is the agency's; a run whose cost is not known
// says so and is never a zero. Each row names the exact model ids its calls
// recorded (AW-01's priced settle, 0055), and counts a call that named none.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import type { AgentCostsResult } from '../../packages/core-wire/src/index.ts';
import { BRAVO_CANARY, createCostWorld, RECORD_CANARY, type CostWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const DAY = 24 * 60 * 60 * 1000;

/** A settled call that named its model and units. */
const named = (minor: number, model: string) =>
  ({ state: 'settled', minor, model, units: [minor * 10, minor] }) as const;

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('MP-14-6 what our agents cost us', () => {
  let w: CostWorld;
  let clientA: string;
  let clientB: string;
  const runs = { a: '', b: '', agency: '', unpriced: '', old: '' };
  const period = () => ({
    from: new Date(Date.now() - DAY).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
  });

  const costs = async (who = w.finance, body: object = period()): Promise<AgentCostsResult> => {
    const answer = await w.read(who, 'finance.agent_costs', body);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body as unknown as AgentCostsResult;
  };

  beforeAll(async () => {
    w = await createCostWorld('mp146');
    clientA = await w.client('Client A');
    clientB = await w.client('Client B');
    await w.controls.fixture.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, w.clientReader, 'read', { kind: 'party', id: clientA }, false, 'finance');
    });
    runs.a = (await w.run({ client: clientA, calls: [named(120, 'model-one')] })).runId;
    runs.b = (await w.run({ client: clientB, calls: [{ state: 'settled', minor: 80 }] })).runId;
    runs.agency = (await w.run({ calls: [named(45, 'model-two')], finish: true })).runId;
    runs.unpriced = (
      await w.run({
        client: clientA,
        calls: [named(10, 'model-one'), { state: 'liability_unknown' }],
      })
    ).runId;
    runs.old = (await w.run({ calls: [{ state: 'settled', minor: 999 }], hoursAgo: 48 })).runId;
  }, 300_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('MP-14-6 spend per agent and per client shows for the period, from the same rows', async () => {
    const result = await costs();
    expect(result.runs.map((one) => one.runId).toSorted()).toStrictEqual(
      [runs.a, runs.b, runs.agency, runs.unpriced].toSorted(),
    );
    const [agent] = result.byAgent;
    expect(result.byAgent).toHaveLength(1);
    expect(agent).toMatchObject({
      agentActorId: w.agentActorId,
      runs: 4,
      unpricedRuns: 1,
      total: '245',
    });
    const byKey = new Map(
      result.byAttachment.map((one) => [
        one.attachment.kind === 'client' ? one.attachment.id : 'agency',
        one,
      ]),
    );
    expect(byKey.get(clientA)).toMatchObject({ runs: 2, unpricedRuns: 1, total: '120' });
    expect(byKey.get(clientB)).toMatchObject({ runs: 1, unpricedRuns: 0, total: '80' });
    expect(byKey.get('agency')).toMatchObject({ runs: 1, unpricedRuns: 0, total: '45' });
    const sum = result.byAttachment.reduce((all, one) => all + BigInt(one.total), 0n);
    expect(sum).toBe(BigInt(agent?.total ?? '0'));
  });

  it('MP-14-6 the period bounds the log: a run before it is not shown or counted', async () => {
    const result = await costs();
    expect(JSON.stringify(result)).not.toContain(runs.old);
    const wide = await costs(w.finance, {
      from: new Date(Date.now() - 3 * DAY).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(wide.runs.map((one) => one.runId)).toContain(runs.old);
  });

  it('MP-14-6 a malformed or empty period is refused', async () => {
    const now = new Date().toISOString();
    for (const [body, field] of [
      [{}, 'from'],
      [{ from: 'yesterday', to: now }, 'from'],
      [{ from: now, to: 'tomorrow' }, 'to'],
      [{ from: now, to: now }, 'to'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one body at a time
      const answer = await w.read(w.finance, 'finance.agent_costs', body);
      expect(answer.status).toBe(422);
      expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
      expect(answer.body['names']).toStrictEqual([field]);
      expect(answer.body['runs']).toBeUndefined();
    }
  });

  it('MP-14-6 unpriced runs say so', async () => {
    const result = await costs();
    const unpriced = result.runs.find((one) => one.runId === runs.unpriced);
    expect(unpriced?.cost).toBeNull();
    expect(unpriced?.unpriced).toEqual(expect.any(String));
    const priced = result.runs.find((one) => one.runId === runs.a);
    expect(priced).toMatchObject({ cost: '120', unpriced: null });
  });

  it('MP-14-6 attachment falls back to "the agency"', async () => {
    const result = await costs();
    const byRun = new Map(result.runs.map((one) => [one.runId, one.attachment]));
    expect(byRun.get(runs.agency)).toStrictEqual({ kind: 'agency' });
    expect(byRun.get(runs.a)).toStrictEqual({
      kind: 'client',
      id: clientA,
      name: `Client A ${RECORD_CANARY}`,
    });
  });

  it('MP-14-6 exact model ids per run: the ids its calls named, and a call that named none counted', async () => {
    const result = await costs();
    const models = Object.fromEntries(result.runs.map((one) => [one.runId, one.models]));
    expect(models).toStrictEqual({
      [runs.a]: { ids: ['model-one'], unnamedCalls: 0 },
      [runs.b]: { ids: [], unnamedCalls: 1 },
      [runs.agency]: { ids: ['model-two'], unnamedCalls: 0 },
      [runs.unpriced]: { ids: ['model-one'], unnamedCalls: 0 },
    });
  });

  it('MP-14-6 internal face only: finance:read, a person’s read with no agent route', () => {
    const declared = COMMAND_SURFACE.find((one) => one.name === 'finance.agent_costs');
    expect([declared?.kind, declared?.collection, declared?.action, declared?.agent]).toStrictEqual(
      ['read', 'finance', 'read', 'never'],
    );
  });

  it('MP-14-6 refusal finance:read: a member holding every grant but it is refused', async () => {
    const answer = await w.read(w.plain, 'finance.agent_costs', period());
    expect(answer.status).toBe(403);
    expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(answer.body['runs']).toBeUndefined();
  });

  it('MP-14-6 refusal: an agent under a live delegation reads no costs', async () => {
    const task = await w.controls.createTask('agent crossing');
    const proposal = await w.controls.propose(task.id, task.revision);
    const picked = await w.controls.pickup(await w.controls.approve(proposal));
    const answer = await w.controls.asAgent(
      'finance.agent_costs',
      period(),
      String(picked['credential']),
    );
    w.answers.push(answer);
    expect(answer.status).toBe(403);
    expect(String(answer.body['code'])).toMatch(/^(DELEGATION_|AUTH_)/u);
    expect(answer.body['runs']).toBeUndefined();
    await w.controls.asPerson('delegation.revoke', { delegationId: picked['delegationId'] });
  });

  it('MP-14-6 isolation: another business never sees or counts these runs', async () => {
    const theirs = await w.read(w.bravoFinance, 'finance.agent_costs', period(), 'bravo');
    expect(theirs.status).toBe(200);
    expect(theirs.body).toMatchObject({ runs: [], byAgent: [], byAttachment: [] });
    const text = JSON.stringify(theirs.body);
    for (const id of [...Object.values(runs), clientA, clientB, w.agentActorId]) {
      expect(text).not.toContain(id);
    }
    expect(JSON.stringify(await costs())).not.toContain(BRAVO_CANARY);
  });

  it('MP-14-6 isolation: a client-scoped reader sees only that client’s runs, in rows and totals', async () => {
    const result = await costs(w.clientReader);
    expect(result.runs.map((one) => one.runId).toSorted()).toStrictEqual(
      [runs.a, runs.unpriced].toSorted(),
    );
    expect(result.byAttachment.map((one) => one.attachment)).toStrictEqual([
      { kind: 'client', id: clientA, name: `Client A ${RECORD_CANARY}` },
    ]);
    expect(result.byAgent[0]).toMatchObject({ runs: 2, unpricedRuns: 1, total: '120' });
    const text = JSON.stringify(result);
    expect(text).not.toContain(clientB);
    expect(text).not.toContain(runs.agency);
  });

  it('MP-14-6 canary: no client name or task title reaches a refusal, and no foreign one any body', () => {
    for (const answer of w.answers) {
      const text = JSON.stringify(answer.body);
      expect(text).not.toContain(BRAVO_CANARY);
      if (answer.status !== 200) expect(text).not.toContain(RECORD_CANARY);
    }
  });
});
