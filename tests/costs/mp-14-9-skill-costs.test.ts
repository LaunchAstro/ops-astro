// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-14-9: skill costing on Connections & signal, the data half (U39, #492),
// in money minor units per run (ORCH37 on the SL13 ask): a skill's figure is
// built only from the runs pinned to one of its versions, a mean only from
// more than one priced run, with its spread; the attribution split's buckets
// add back to the total. The in/out split and the model ids wait on the broker
// recording them (LEANS-ON SL11), and the process document on Docs (phase 4):
// each is a named field, unavailable with its reason.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import type { SkillCostsResult, SkillCostView } from '../../packages/core-wire/src/index.ts';
import { BRAVO_CANARY, createCostWorld, RECORD_CANARY, type CostWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

const row = (result: SkillCostsResult, id: string): SkillCostView | undefined =>
  result.costing?.skills.find((one) => one.skillId === id);

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('MP-14-9 skill costing', () => {
  let w: CostWorld;
  let clientA: string;
  let clientB: string;
  const skills = { mean: '', one: '', none: '', never: '' };
  const runs: string[] = [];

  const costs = async (who = w.finance, business = 'alpha'): Promise<SkillCostsResult> => {
    const answer = await w.read(who, 'finance.skill_costs', {}, business);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body as unknown as SkillCostsResult;
  };

  beforeAll(async () => {
    w = await createCostWorld('mp149');
    clientA = await w.client('Client A');
    clientB = await w.client('Client B');
    await w.controls.fixture.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, w.clientReader, 'read', { kind: 'party', id: clientA }, false, 'finance');
    });
    const mean = await w.skill('Monthly report');
    const one = await w.skill('Landing page copy');
    const none = await w.skill('Schema markup');
    const never = await w.skill('Never run');
    skills.mean = mean.id;
    skills.one = one.id;
    skills.none = none.id;
    skills.never = never.id;
    const specs = [
      {
        skill: mean.versionId,
        calls: [
          { state: 'settled', minor: 40 },
          { state: 'settled', minor: 60 },
        ],
        finish: true,
      },
      { skill: mean.versionId, calls: [{ state: 'settled', minor: 300 }], finish: true },
      { skill: mean.versionId, calls: [{ state: 'settled', minor: 500 }] },
      {
        skill: mean.versionId,
        calls: [{ state: 'settled', minor: 90 }, { state: 'liability_unknown' }],
      },
      { skill: one.versionId, client: clientA, calls: [{ state: 'settled', minor: 250 }] },
      { skill: none.versionId, calls: [{ state: 'liability_unknown' }] },
      { client: clientB, calls: [{ state: 'settled', minor: 70 }] },
    ] as const;
    for (const spec of specs) {
      // eslint-disable-next-line no-await-in-loop -- the agent holds one delegation at a time
      runs.push((await w.run(spec)).runId);
    }
  }, 300_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('MP-14-9 the section is absent when nothing has run', async () => {
    // Bravo has a skill of its own and no run.
    const theirs = await costs(w.bravoFinance, 'bravo');
    expect(theirs).toStrictEqual({ ok: true, costing: null });
  });

  it('MP-14-9 three figure branches: mean with spread, one run, none', async () => {
    const result = await costs();
    expect(result.costing?.skills.map((one) => one.skillId)).toStrictEqual([
      skills.mean,
      skills.one,
      skills.none,
    ]);
    const mean = row(result, skills.mean);
    // Four runs on the skill, three priced: 100 (two calls), 300 and 500.
    expect(mean).toMatchObject({
      name: 'Monthly report',
      runs: 4,
      soloRuns: 4,
      sharedRuns: 0,
      unpricedRuns: 1,
      tasks: 4,
      soloTotal: '900',
      figure: { kind: 'mean', mean: '300', lo: '100', hi: '500', finishedMean: '200' },
    });
    expect(row(result, skills.one)).toMatchObject({
      runs: 1,
      unpricedRuns: 0,
      figure: { kind: 'one', amount: '250' },
    });
    // Run once, but its one run's cost is not known: no figure, never a zero.
    expect(row(result, skills.none)).toMatchObject({
      runs: 1,
      unpricedRuns: 1,
      soloTotal: '0',
      figure: { kind: 'none' },
    });
    expect(row(result, skills.never)).toBeUndefined();
    const currency = mean?.currency;
    expect(currency).toMatch(/^[A-Z]{3}$/u);
    for (const one of result.costing?.skills ?? []) expect(one.currency).toBe(currency);
  });

  it('MP-14-9 attribution buckets add back to the total', async () => {
    const result = await costs();
    const [split] = result.costing?.split ?? [];
    expect(result.costing?.split).toHaveLength(1);
    expect(split).toMatchObject({
      runs: 7,
      total: '1220',
      solo: { runs: 6, total: '1150' },
      shared: { runs: 0, total: '0' },
      unattributed: { runs: 1, total: '70' },
      unpricedRuns: 2,
    });
    if (split === undefined) throw new Error('no split');
    expect(split.solo.runs + split.shared.runs + split.unattributed.runs).toBe(split.runs);
    expect(
      BigInt(split.solo.total) + BigInt(split.shared.total) + BigInt(split.unattributed.total),
    ).toBe(BigInt(split.total));
  });

  it('MP-14-9 skill names carry the process document, drawn unavailable with its reason until Docs exists', async () => {
    const result = await costs();
    for (const one of result.costing?.skills ?? []) {
      expect(one.document.available).toBe(false);
      expect(one.document.reason).toMatch(/Docs/u);
      expect(one.document).not.toHaveProperty('href');
    }
  });

  it('MP-14-9 the in/out split and the model ids are named, unavailable with their reason', async () => {
    const result = await costs();
    for (const one of result.costing?.skills ?? []) {
      expect(one.usage).toStrictEqual({ available: false, reason: expect.any(String) });
      expect(one.models).toStrictEqual({ available: false, reason: expect.any(String) });
    }
  });

  it('MP-14-9 refusal finance:read: a member holding every grant but it is refused', async () => {
    const answer = await w.read(w.plain, 'finance.skill_costs', {});
    expect(answer.status).toBe(403);
    expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(answer.body['costing']).toBeUndefined();
  });

  it('MP-14-9 refusal: an agent under a live delegation reads no skill costing', async () => {
    const task = await w.controls.createTask('agent crossing');
    const proposal = await w.controls.propose(task.id, task.revision);
    const picked = await w.controls.pickup(await w.controls.approve(proposal));
    const answer = await w.controls.asAgent(
      'finance.skill_costs',
      {},
      String(picked['credential']),
    );
    w.answers.push(answer);
    expect(answer.status).toBe(403);
    expect(String(answer.body['code'])).toMatch(/^(DELEGATION_|AUTH_)/u);
    expect(answer.body['costing']).toBeUndefined();
    await w.controls.asPerson('delegation.revoke', { delegationId: picked['delegationId'] });
  });

  it('MP-14-9 isolation: another business never sees or counts these runs', async () => {
    const theirs = await w.read(w.bravoFinance, 'finance.skill_costs', {}, 'bravo');
    const text = JSON.stringify(theirs.body);
    for (const id of [...runs, ...Object.values(skills), clientA, clientB]) {
      expect(text).not.toContain(id);
    }
    expect(text).not.toContain('Monthly report');
    const ours = JSON.stringify(await costs());
    expect(ours).not.toContain(BRAVO_CANARY);
  });

  it('MP-14-9 isolation: a client-scoped reader sees only that client’s runs, in rows and in the split', async () => {
    const result = await costs(w.clientReader);
    expect(result.costing?.skills.map((one) => one.skillId)).toStrictEqual([skills.one]);
    expect(result.costing?.split[0]).toMatchObject({
      runs: 1,
      total: '250',
      solo: { runs: 1, total: '250' },
      unattributed: { runs: 0, total: '0' },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(clientB);
    expect(text).not.toContain('Monthly report');
  });

  it('MP-14-9 canary: no client name, task title or foreign skill reaches any body, refusals included', () => {
    for (const answer of w.answers) {
      const text = JSON.stringify(answer.body);
      expect(text).not.toContain(RECORD_CANARY);
      expect(text).not.toContain(BRAVO_CANARY);
    }
  });

  it('MP-14-9 parity: skill costing is finance:read, a person’s read with no agent route', () => {
    const declared = COMMAND_SURFACE.find((one) => one.name === 'finance.skill_costs');
    expect([declared?.kind, declared?.collection, declared?.action, declared?.agent]).toStrictEqual(
      ['read', 'finance', 'read', 'never'],
    );
  });
});
