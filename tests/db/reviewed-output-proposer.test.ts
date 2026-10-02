// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08 in the schema: a reviewed output is the work of the lease it names
// (`0111_reviewed_output_proposer`). The application role may insert into
// `reviewed_outputs`, so the trigger is the barrier behind the handback and
// `markRevision`: the version's proposer must be the lease's holder. Without
// it a direct insert could mark a person's version, or another actor's, as
// the agent's output, and approving it would launch an effect no agent
// produced under that lease.
//
// The refusals are written straight through the application role, with no
// code path in front of them. The controls are the product's own marks, the
// handback's and the agent's revision after requested changes (N9-M2), and
// the same row with only the lease changed. Another business's mark is
// refused by row security before the trigger answers.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isReviewedOutput } from '../../packages/core-runtime/src/reviewed-output.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentOutput, type AgentOutput } from '../runtime/aw-09-agent-round.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  freshPurpose,
  openSchedules,
  proposeBody,
  revisionOf,
  rows,
  seedSchedules,
  type Detail,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { decideBody } from '../runtime/t3a-support.ts';

const serverUrl = databaseUrlFromEnvironment();
const EFFECT = { kind: 'synthetic_comment', payload: {} } as const;
const MARK = `insert into public.reviewed_outputs (business_id, version_id, lineage_id, lease_id)
  values ($1, $2, $3, $4)`;
const NOT_THE_HOLDERS = /the lease's holder proposed the version/u;
/** Thrown to end a transaction whose write was accepted, so the world keeps no trace of it. */
const ACCEPTED = new Error('accepted, rolled back');

type Answer = 'accepted' | { readonly code: string; readonly message: string };
type Setup = readonly (readonly [string, readonly unknown[]])[];

const reviewed = async (on: Schedules, versionId: unknown): Promise<boolean> =>
  await on.db.app.withBusiness(on.business, (tx) => isReviewedOutput(tx, String(versionId)));

// eslint-disable-next-line max-lines-per-function -- five cases over one world
describe.skipIf(serverUrl === undefined)('a reviewed output is its lease holder’s work', () => {
  let s: Schedules;
  let other: Schedules;

  beforeAll(async () => {
    s = await openSchedules('ro_guard', 1_000_000);
    other = await seedSchedules(s.db, 'ro_guard_other', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  /** The agent's handed-back output with changes requested on it. */
  const changesAsked = async (): Promise<AgentOutput> => {
    const { output } = await agentOutput(s, undefined, EFFECT);
    expect(codeOf(await asPerson(s, decideBody({ ...output }, 'request_changes')))).toBe('applied');
    return output;
  };

  /** A revision on the output's lineage, by the agent (its delegation) or by the person. */
  const revisedBy = async (output: AgentOutput, who: 'agent' | 'person'): Promise<Detail> => {
    const body = {
      ...proposeBody(output.taskId, await revisionOf(s, output.taskId), {
        purpose: freshPurpose(),
        maximumMinor: 1_000,
        lineageId: output.lineageId,
      }),
      step: EFFECT,
    };
    const result =
      who === 'agent' ? await asAgent(s, body, output.delegation) : await asPerson(s, body);
    return appliedDetail(result, `${who} revision`);
  };

  /** The lease the mark on `versionId` names. */
  const markLease = async (versionId: unknown): Promise<string> => {
    const found = await rows<{ readonly lease_id: string }>(
      s,
      `select lease_id from public.reviewed_outputs where business_id = $1 and version_id = $2`,
      [s.business, versionId],
    );
    return String(found[0]?.lease_id);
  };

  /**
   * One mark written as the application role in `business`, after the owner's
   * `setup`, in a transaction that always rolls back.
   */
  const markAsApp = async (
    business: string,
    mark: readonly unknown[],
    setup: Setup = [],
  ): Promise<Answer> => {
    try {
      await s.db.admin.transaction(async (execute) => {
        for (const [text, parameters] of setup) {
          // eslint-disable-next-line no-await-in-loop -- in order
          await execute(text, parameters);
        }
        await execute('set local role ops_astro_app');
        await execute(`select set_config('app.business_id', $1, true)`, [business]);
        await execute(MARK, mark);
        throw ACCEPTED;
      });
    } catch (error) {
      if (error === ACCEPTED) return 'accepted';
      return { code: String((error as { code?: unknown }).code), message: String(error) };
    }
    throw new Error('the transaction neither threw nor rolled back');
  };

  /** The agent's revision with its product mark lifted, so a test may write the mark itself. */
  const unmarked = async (): Promise<{
    readonly mark: readonly unknown[];
    readonly lift: Setup;
  }> => {
    const output = await changesAsked();
    const revision = await revisedBy(output, 'agent');
    const leaseId = await markLease(revision['versionId']);
    return {
      mark: [s.business, revision['versionId'], output.lineageId, leaseId],
      lift: [
        [
          `delete from public.reviewed_outputs where business_id = $1 and version_id = $2`,
          [s.business, revision['versionId']],
        ],
      ],
    };
  };

  it("a direct app-role insert marking a person's version as the reviewed output is refused", async () => {
    const output = await changesAsked();
    const own = await revisedBy(output, 'person');
    expect(await reviewed(s, own['versionId'])).toBe(false);
    const leaseId = await markLease(output.versionId);

    await expect(
      s.db.app.withBusiness(s.business, (tx) =>
        tx.query(MARK, [s.business, own['versionId'], output.lineageId, leaseId]),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(NOT_THE_HOLDERS) });
    expect(await reviewed(s, own['versionId'])).toBe(false);
  });

  it('a mark naming a lease whose holder did not propose the version is refused', async () => {
    const { mark, lift } = await unmarked();
    const [business, , , leaseId] = mark;
    const otherLease = randomUUID();
    const otherAgent = randomUUID();
    // Another agent's lease on the same run: the lineage and the work it ran
    // under are the real lease's, only the holder differs.
    const anotherHolder: Setup = [
      ...lift,
      [
        `insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`,
        [business, otherAgent],
      ],
      [
        `insert into public.leases (business_id, id, task_id, run_id, reservation_id,
           holder_actor_id, authorised_by_person_id, fence, state, expires_at, released_at)
         select business_id, $3, task_id, run_id, reservation_id, $4, authorised_by_person_id,
                fence + 1000, 'released', expires_at, now()
           from public.leases where business_id = $1 and id = $2`,
        [business, leaseId, otherLease, otherAgent],
      ],
    ];

    const refused = await markAsApp(s.business, [...mark.slice(0, 3), otherLease], anotherHolder);
    expect(refused).toMatchObject({
      code: '23514',
      message: expect.stringMatching(NOT_THE_HOLDERS),
    });
    // Control: the same row naming the lease whose holder proposed it.
    expect(await markAsApp(s.business, mark, anotherHolder)).toBe('accepted');
  });

  it("the handback's own mark is accepted", async () => {
    const { output, work } = await agentOutput(s, undefined, EFFECT);
    expect(await reviewed(s, output.versionId)).toBe(true);
    expect(await markLease(output.versionId)).toBe(String(work.picked['leaseId']));
  });

  it("the agent's revision under the same lease (N9-M2) is accepted", async () => {
    const output = await changesAsked();
    const revision = await revisedBy(output, 'agent');
    expect(await reviewed(s, revision['versionId'])).toBe(true);
    expect(await markLease(revision['versionId'])).toBe(await markLease(output.versionId));
  });

  it('a mark in another business is refused before the trigger answers (row security)', async () => {
    const { mark, lift } = await unmarked();
    // Control: at home the row is the lease holder's own work, and it is accepted.
    expect(await markAsApp(s.business, mark, lift)).toBe('accepted');

    const crossed = await markAsApp(other.business, mark, lift);
    expect(crossed).toMatchObject({ code: '42501' });
    if (crossed === 'accepted') return;
    expect(crossed.message).toMatch(/row-level security/u);
    for (const id of mark) expect(crossed.message).not.toContain(String(id));

    // Control: the other business's own handback marks its output.
    const theirs = await agentOutput(other, undefined, EFFECT);
    expect(await reviewed(other, theirs.output.versionId)).toBe(true);
    expect(await reviewed(other, mark[1])).toBe(false);
  });
});
