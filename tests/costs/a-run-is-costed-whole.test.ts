// SPDX-License-Identifier: AGPL-3.0-only
//
// A run is costed whole (Sol PRV-oa-1137-R1). A helper's calls are its own,
// though they spend on its parent's lease and reservation. A call held and not
// yet started leaves its run unpriced. A run with any open call is unpriced in
// every row, so no part of it reaches a total, and a run's first started call
// places all of its rows in a period, a replacement's too. Only an accepted
// completed handback finishes a run, never a revoked holder's late report. A
// period is a real calendar date and time: an impossible one is refused, never
// moved to the nearest real one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { AgentCostsResult, SkillCostsResult } from '../../packages/core-wire/src/index.ts';
import { anotherAgent, helperChild, letPickupsDelegate, replace } from './crossings.ts';
import { createCostWorld, type CostWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const HOUR = 60 * 60 * 1000;

/** The hour either side of `hoursAgo`, so each case reads only its own runs. */
const around = (hoursAgo: number) => ({
  from: new Date(Date.now() - (hoursAgo + 1) * HOUR).toISOString(),
  to: new Date(Date.now() - (hoursAgo - 1) * HOUR).toISOString(),
});

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('a run is costed whole', () => {
  let w: CostWorld;

  const log = async (body: object): Promise<AgentCostsResult> => {
    const answer = await w.read(w.finance, 'finance.agent_costs', body);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body as unknown as AgentCostsResult;
  };
  const skillRow = async (skillId: string) => {
    const answer = await w.read(w.finance, 'finance.skill_costs', {});
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const costing = (answer.body as unknown as SkillCostsResult).costing;
    return costing?.skills.find((one) => one.skillId === skillId);
  };
  /** A run's rows as [agent, cost], in agent order: one run's rows share their start. */
  const rowsOf = (result: AgentCostsResult, runId: string) =>
    result.runs
      .filter((one) => one.runId === runId)
      .map((one) => [one.agentActorId, one.cost])
      .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])));
  const sorted = (pairs: readonly (readonly [string, string | null])[]) =>
    pairs.toSorted((a, b) => a[0].localeCompare(b[0]));
  const totalOf = (result: AgentCostsResult, client: string) =>
    result.byAttachment.find(
      (one) => one.attachment.kind === 'client' && one.attachment.id === client,
    );

  beforeAll(async () => {
    w = await createCostWorld('costwhole');
    await letPickupsDelegate(w);
  }, 300_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('F1 a helper’s calls are the helper’s, though they spend on its parent’s lease', async () => {
    const client = await w.client('Helped');
    const parent = await w.run({ client, calls: [], end: 'open' });
    const helper = await anotherAgent(w);
    const child = await helperChild(w, parent, helper);
    await w.calls(
      parent,
      [
        { state: 'settled', minor: 20 },
        { state: 'settled', minor: 80, by: child },
      ],
      50,
    );
    // Taken back once its calls are made, so the agent may pick up the next case's run.
    await w.controls.asPerson('delegation.revoke', { delegationId: parent.picked['delegationId'] });
    const result = await log(around(50));
    expect(rowsOf(result, parent.runId)).toStrictEqual(
      sorted([
        [w.agentActorId, '20'],
        [helper.actorId, '80'],
      ]),
    );
    const byAgent = (id: string) => result.byAgent.find((one) => one.agentActorId === id)?.total;
    expect([byAgent(w.agentActorId), byAgent(helper.actorId)]).toStrictEqual(['20', '80']);
    expect(totalOf(result, client)).toMatchObject({ runs: 1, total: '100' });
  });

  it('F2 a call held and not yet started leaves its run unpriced in both reads', async () => {
    const skill = await w.skill('Held call skill');
    const ran = await w.run({
      skill: skill.versionId,
      calls: [{ state: 'settled', minor: 100 }, { state: 'reserved' }],
      hoursAgo: 60,
    });
    const result = await log(around(60));
    const row = result.runs.find((one) => one.runId === ran.runId);
    expect(row).toMatchObject({ cost: null });
    expect(row?.unpriced).not.toBeNull();
    expect(result.byAgent.map((one) => [one.total, one.unpricedRuns])).toStrictEqual([['0', 1]]);
    expect(await skillRow(skill.id)).toMatchObject({
      runs: 1,
      unpricedRuns: 1,
      figure: { kind: 'none' },
      soloTotal: '0',
    });
  });

  it('F3 a run with an open call is unpriced in every agent’s row and adds to no total', async () => {
    const client = await w.client('Replaced');
    const skill = await w.skill('Replaced skill');
    const first = await w.run({
      client,
      skill: skill.versionId,
      calls: [{ state: 'settled', minor: 100 }],
      end: 'open',
      leaseSeconds: 1,
      hoursAgo: 70,
    });
    const b = await anotherAgent(w);
    const second = await replace(w, first, b);
    await w.calls(second, [{ state: 'liability_unknown' }], 70);
    const result = await log(around(70));
    expect(rowsOf(result, first.runId)).toStrictEqual(
      sorted([
        [w.agentActorId, null],
        [b.actorId, null],
      ]),
    );
    expect(result.byAgent.map((one) => [one.total, one.unpricedRuns])).toStrictEqual([
      ['0', 1],
      ['0', 1],
    ]);
    expect(totalOf(result, client)).toMatchObject({ runs: 1, unpricedRuns: 1, total: '0' });
    expect(await skillRow(skill.id)).toMatchObject({ unpricedRuns: 1, soloTotal: '0' });
  });

  it('F4 a run’s first started call places all its rows in one period, a replacement’s too', async () => {
    const client = await w.client('Across the month');
    const first = await w.run({
      client,
      calls: [{ state: 'settled', minor: 100, at: new Date('2026-01-31T23:55:00Z') }],
      end: 'open',
      leaseSeconds: 1,
    });
    const b = await anotherAgent(w);
    const second = await replace(w, first, b);
    await w.calls(second, [{ state: 'settled', minor: 200, at: new Date('2026-02-01T00:05:00Z') }]);
    const january = await log({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' });
    expect(rowsOf(january, first.runId)).toStrictEqual(
      sorted([
        [w.agentActorId, '100'],
        [b.actorId, '200'],
      ]),
    );
    expect(totalOf(january, client)).toMatchObject({ runs: 1, total: '300' });
    const february = await log({ from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z' });
    expect(rowsOf(february, first.runId)).toStrictEqual([]);
    expect(totalOf(february, client)).toBeUndefined();
  });

  it('F5 a revoked holder’s late completed report does not finish its run', async () => {
    const skill = await w.skill('Late report skill');
    await w.run({
      skill: skill.versionId,
      calls: [{ state: 'settled', minor: 100 }],
      finish: true,
    });
    const late = await w.run({
      skill: skill.versionId,
      calls: [{ state: 'settled', minor: 300 }],
      end: 'late',
    });
    const kept = await w.controls.count(
      `select count(*)::text as n from public.handback_reports
        where run_id = $1 and disposition = 'retained' and outcome = 'completed'`,
      [late.runId],
    );
    expect(kept).toBe(1);
    expect((await skillRow(skill.id))?.figure).toStrictEqual({
      kind: 'mean',
      mean: '200',
      lo: '100',
      hi: '300',
      finishedMean: null,
    });
  });

  it('F7 an impossible calendar date or time is refused naming its field, never normalised', async () => {
    const to = '2026-03-03T00:00:00Z';
    for (const [body, field] of [
      [{ from: '2026-02-30T00:00:00Z', to }, 'from'],
      [{ from: '2026-04-31T00:00:00Z', to: '2026-05-03T00:00:00Z' }, 'from'],
      [{ from: '2026-13-01T00:00:00Z', to: '2027-03-03T00:00:00Z' }, 'from'],
      [{ from: '2026-03-01T24:00:00Z', to }, 'from'],
      [{ from: '2026-03-01T12:60:00Z', to }, 'from'],
      [{ from: '2026-03-01T12:00:60Z', to }, 'from'],
      [{ from: '2026-03-01T00:00:00+15:00', to }, 'from'],
      [{ from: '2026-03-01T00:00:00+14:30', to }, 'from'],
      [{ from: '2026-03-01T00:00:00+10:60', to }, 'from'],
      [{ from: '2026-03-01T00:00:00Z', to: '2027-02-29T00:00:00Z' }, 'to'],
      [{ from: '2026-03-01T00:00:00Z', to: '2026-03-00T00:00:00Z' }, 'to'],
      // Counted from the fields: west of UTC is later, and a fraction is part of the instant.
      [{ from: '2026-03-01T00:00:00-10:00', to: '2026-03-01T09:00:00Z' }, 'to'],
      [{ from: '2026-03-01T00:00:00.5Z', to: '2026-03-01T00:00:00.4Z' }, 'to'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one body at a time
      const answer = await w.read(w.finance, 'finance.agent_costs', body);
      expect(answer.status, `${JSON.stringify(body)} ${JSON.stringify(answer.body)}`).toBe(422);
      expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
      expect(answer.body['names']).toStrictEqual([field]);
    }
    // A tenth of a second apart is a period: the fraction is counted, not dropped.
    await log({ from: '2026-03-01T00:00:00.4Z', to: '2026-03-01T00:00:00.5Z' });
    const leap = await log({
      from: '2028-02-29T00:00:00.5+00:00',
      to: '2028-03-01T00:00:00-14:00',
    });
    expect(leap.period).toStrictEqual({
      from: '2028-02-29T00:00:00.500Z',
      to: '2028-03-01T14:00:00.000Z',
    });
  });
});
