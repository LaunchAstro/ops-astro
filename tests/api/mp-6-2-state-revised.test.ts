// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2, `state revised` (CS-16.4), through the real boundary and a fresh
// Postgres.
//
// `run.revise_state` is the Agent page's one write: the run records what it
// knows so far, as a new version of its state, under its worker lease. Each
// revision is kept, with the lease holder as its actor, and the run's current
// knowledge is its newest. Nothing of it is memory: no later run reads it
// (RA-10). Its authority (`run:write`) and isolation are in
// `mp-6-2-revisions-isolation.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detailOf } from './controls-fixture.ts';
import { pickedUpOn } from './mp-6-1-checks-fixture.ts';
import { handBack } from './mp-6-2-fixture.ts';
import {
  REVISIONS,
  knowledge,
  revisionsWorld,
  type RevisionsWorld,
} from './mp-6-2-revisions-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const MALFORMED: readonly Readonly<Record<string, unknown>>[] = [
  { valid: [{ k: '', v: 'no key' }], unknowns: [], stale: [] },
  { valid: [{ k: 'Key' }], unknowns: [], stale: [] },
  { valid: 'Key: value', unknowns: [], stale: [] },
  { valid: [], unknowns: ['  '], stale: [] },
  { valid: [], unknowns: [], stale: [{ k: 'Hours' }] },
  { valid: [], unknowns: [], stale: [], step: 'x'.repeat(121) },
  { valid: [{ k: 'Key', v: 'value', extra: 'field' }], unknowns: [], stale: [] },
  { valid: [], unknowns: [] },
  { valid: [], unknowns: [`a${String.fromCodePoint(0)}b`], stale: [] },
  { valid: [{ k: 'Key', v: String.fromCodePoint(0xd8_00) }], unknowns: [], stale: [] },
];

// eslint-disable-next-line max-lines-per-function -- one business, the revisions its runs record
describe.skipIf(serverUrl === undefined)('MP-6-2 state revised', () => {
  let w: RevisionsWorld;

  beforeAll(async () => {
    w = await revisionsWorld('mp_6_2_state_revised');
  }, 180_000);

  afterAll(async () => await w?.c.drop());

  // eslint-disable-next-line max-lines-per-function -- the named test's cases, each on its own run
  describe('MP-6-2 revisions', () => {
    it('keeps each revision as a version, the agent as its actor, the newest current', async () => {
      const work = await pickedUpOn(w.c, 'revise_twice');
      expect((await w.revise(work, knowledge('first'))).status).toBe(200);
      const second = await w.revise(work, {
        step: 'checked the claims',
        valid: [
          { k: 'Live opening', v: 'about the practice' },
          { k: 'Compliance', v: 'no superlative used' },
        ],
        unknowns: [],
        stale: [],
      });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(detailOf(second)['version']).toBe(2);

      const revisions = await w.revisionsOn(work.taskId);
      expect(revisions.map((one) => one.version)).toStrictEqual([1, 2]);
      expect(revisions[0]).toMatchObject({
        step: 'read the page first',
        valid: [{ k: 'Live opening', v: 'about the practice first' }],
        unknowns: ['whether the form loses the reader first'],
        stale: [{ k: 'Hours', why: 'changed since the brief first' }],
        revisedByActorId: w.c.fixture.agentActorId,
      });
      expect(revisions[1]?.valid.map((row) => row.k)).toStrictEqual(['Live opening', 'Compliance']);
      expect(revisions[1]?.unknowns).toStrictEqual([]);

      const rows = await w.c.fixture.db.admin.execute(
        `select distinct lease_id, actor_id, version_id from public.run_state_revisions
          where task_id = $1`,
        [work.taskId],
      );
      expect(rows).toEqual([
        { lease_id: work.leaseId, actor_id: w.c.fixture.agentActorId, version_id: work.versionId },
      ]);
    });

    it('refuses malformed knowledge and writes nothing', async () => {
      const work = await pickedUpOn(w.c, 'revise_malformed');
      const answers = await Promise.all(MALFORMED.map(async (bad) => await w.revise(work, bad)));
      for (const [index, answer] of answers.entries()) {
        expect(answer.status, JSON.stringify(MALFORMED[index])).toBe(422);
        expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
      }
      expect(await w.c.count(REVISIONS, [work.taskId])).toBe(0);
    });

    it('two revisions at once are v and v+1, never two of one version', async () => {
      const work = await pickedUpOn(w.c, 'revise_at_once');
      const answers = await Promise.all([
        w.revise(work, knowledge('one')),
        w.revise(work, knowledge('two')),
      ]);
      expect(answers.map((answer) => answer.status)).toStrictEqual([200, 200]);
      expect(answers.map((answer) => detailOf(answer)['version']).toSorted()).toStrictEqual([1, 2]);
      expect((await w.revisionsOn(work.taskId)).map((one) => one.version)).toStrictEqual([1, 2]);
    });

    it('refuses a revision with no live lease and writes nothing', async () => {
      const work = await pickedUpOn(w.c, 'revise_after_handback');
      await handBack(w.c, work);
      const late = await w.revise(work, knowledge('late'));
      // The handback settled the delegation with the lease, so the agent's
      // credential is refused before any lease is read.
      expect(late.status).toBe(401);
      expect(late.body['code']).toBe('DELEGATION_NOT_LIVE');
      expect(await w.c.count(REVISIONS, [work.taskId])).toBe(0);
    });
  });

  describe('MP-6-2 no memory activates', () => {
    it('takes no memory field: a revision carrying one is refused and writes nothing', async () => {
      const work = await pickedUpOn(w.c, 'revise_with_memory');
      const answer = await w.revise(work, {
        ...knowledge('memory'),
        memory: [{ k: 'Client prefers', v: 'short openings' }],
      });
      expect(answer.status).toBe(400);
      expect(answer.body['code']).toBe('COMMAND_BODY_INVALID');
      expect(await w.c.count(REVISIONS, [work.taskId])).toBe(0);
    });

    it('the run’s knowledge stays on its run: the successor version starts knowing nothing', async () => {
      const work = await pickedUpOn(w.c, 'revise_then_hand_back');
      expect((await w.revise(work, knowledge('kept on its run'))).status).toBe(200);
      await handBack(w.c, work);
      const read = await w.c.asPerson('task.read', { recordId: work.taskId });
      const { proposals } = read.body['task'] as {
        proposals: readonly {
          versions: readonly { versionId: string; revisions: readonly unknown[] }[];
        }[];
      };
      const [proposal] = proposals;
      const own = proposal?.versions.find((one) => one.versionId === work.versionId);
      const successor = proposal?.versions.find((one) => one.versionId !== work.versionId);
      expect(own?.revisions).toHaveLength(1);
      expect(successor?.revisions).toStrictEqual([]);
    });

    it('no table holds memory', async () => {
      const tables = await w.c.fixture.db.admin.execute(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_name ilike '%memor%'`,
      );
      expect(tables).toHaveLength(0);
    });
  });

  it('MP-6-2 no audit event beyond run.revise_state’s own', async () => {
    const work = await pickedUpOn(w.c, 'revise_audited_once');
    const audited = async () =>
      await w.c.fixture.db.admin.execute<{ readonly command: string }>(
        `select command from public.audit_events where business_id = $1 order by seq`,
        [w.c.fixture.business],
      );
    const before = (await audited()).length;
    expect((await w.revise(work, knowledge('audit'))).status).toBe(200);
    const after = await audited();
    expect(after.slice(before).map((row) => row.command)).toStrictEqual(['run.revise_state']);
  });
});
