// SPDX-License-Identifier: AGPL-3.0-only
//
// C41-A's inbox raise follows the owner rule (U38, CS-15.4): the reviewers'
// proofs on the draft and the follow-up cases, each red with its fix undone.

import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail, useMoveWorld } from './c41-a-move-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C41-A inbox raise: the move follows its owner', () => {
  const { the, as, onboard, done, revisionOf, assign, openOn, race } = useMoveWorld('c41asol');

  it('a step opening while its task is being assigned leaves the move with the assignee alone, not a stale item to the starter too', async () => {
    const steps = await onboard('Made-up Client Race');
    const kickoff = String(steps.get('kickoff-call'));
    // The result that opens the kickoff step comes while its assignment is uncommitted.
    const answers = await race(
      {
        name: 'task.assign',
        body: {
          recordId: kickoff,
          expectedRevision: await revisionOf(kickoff),
          fields: { assignee: the.assignee.personId },
        },
      },
      {
        name: 'onboarding.step_result',
        body: { recordId: steps.get('welcome-email'), outcome: 'done', result: 'sent' },
      },
    );
    for (const answer of answers) expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    // Both committed and the kickoff task is assigned: its move is the assignee's alone.
    expect(await openOn(kickoff)).toStrictEqual([the.assignee.personId]);
  });

  it('C41-A races: a step result racing the unassignment of its task leaves no item open on the closed step', async () => {
    const steps = await onboard('Made-up Client Closing Race');
    const kickoff = String(steps.get('kickoff-call'));
    await done(steps, 'welcome-email');
    const to = await assign(the.admin, kickoff, the.assignee.personId);
    expect(to.status, JSON.stringify(to.body)).toBe(200);
    // The unassignment parks the ready step on the starter; the result closes it meanwhile.
    const answers = await race(
      {
        name: 'task.assign',
        body: {
          recordId: kickoff,
          expectedRevision: await revisionOf(kickoff),
          fields: { assignee: null },
        },
      },
      {
        name: 'onboarding.step_result',
        body: { recordId: kickoff, outcome: 'done', result: 'held' },
      },
    );
    for (const answer of answers) expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    // The step is closed: nobody owes it a move.
    expect(await openOn(kickoff)).toStrictEqual([]);
  });

  it('unassigning a ready person step leaves it parked with an item to the starter', async () => {
    const steps = await onboard('Made-up Client Unassign');
    const kickoff = String(steps.get('kickoff-call'));
    await done(steps, 'welcome-email');
    expect(await openOn(kickoff)).toStrictEqual([the.admin.personId]);
    const to = await assign(the.admin, kickoff, the.assignee.personId);
    expect(to.status, JSON.stringify(to.body)).toBe(200);
    expect(await openOn(kickoff)).toStrictEqual([the.assignee.personId]);
    const back = await assign(the.admin, kickoff, null);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // No assignee: the move falls back to the person who started the onboarding.
    expect(await openOn(kickoff)).toStrictEqual([the.admin.personId]);
  });

  it('C41-A CS-15.4: unassigning a ready step of a stopped onboarding parks it on nobody', async () => {
    const steps = await onboard('Made-up Client Stopped');
    await done(steps, 'welcome-email');
    await done(steps, 'kickoff-call');
    for (const attempt of ['first', 'second']) {
      // oxlint-disable-next-line no-await-in-loop -- the second failure stops it
      const failed = await as(the.admin, 'onboarding.step_result', {
        recordId: steps.get('site-setup'),
        outcome: 'failed',
        result: `${attempt} try failed`,
      });
      expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    }
    const grant = String(steps.get('access-grant'));
    const to = await assign(the.admin, grant, the.assignee.personId);
    expect(to.status, JSON.stringify(to.body)).toBe(200);
    const back = await assign(the.admin, grant, null);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // A person restarts a stopped onboarding; until then no step is anyone's move.
    expect(await openOn(grant)).toStrictEqual([]);
  });

  it('a person who takes a ready person step themselves holds its item', async () => {
    const steps = await onboard('Made-up Client Self');
    const kickoff = String(steps.get('kickoff-call'));
    await done(steps, 'welcome-email');
    expect(await openOn(kickoff)).toStrictEqual([the.admin.personId]);
    const took = await assign(the.selfAssigner, kickoff, the.selfAssigner.personId);
    expect(took.status, JSON.stringify(took.body)).toBe(200);
    // The move is now the assignee's: the starter's item went, and one is theirs.
    expect(await openOn(kickoff)).toStrictEqual([the.selfAssigner.personId]);
  });
  it('a step whose task moved to another client before it opens raises nothing for this onboarding', async () => {
    const steps = await onboard('Made-up Client Moved');
    const other = await as(the.admin, 'record.create', {
      type: 'client',
      fields: { name: 'Made-up Client Elsewhere' },
    });
    expect(other.status).toBe(200);
    const kickoff = String(steps.get('kickoff-call'));
    const moved = await as(the.admin, 'task.set_party', {
      recordId: kickoff,
      expectedRevision: await revisionOf(kickoff),
      fields: { client: String(detail(other)['recordId']) },
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    await done(steps, 'welcome-email');
    // The task is another client's now: this onboarding no longer closes it
    // (step_result answers 404), so it parks nobody on it either.
    const closing = await as(the.admin, 'onboarding.step_result', {
      recordId: kickoff,
      outcome: 'done',
      result: 'held',
    });
    expect(closing.status).toBe(404);
    expect(await openOn(kickoff)).toStrictEqual([]);
  });

  it('a step its assignee took before it opened raises its item to that assignee when it opens', async () => {
    // Red with the assignee leg of `raiseStepMoves` removed,
    // which every case in c41-a-inbox-raise.test.ts survives (check script).
    const steps = await onboard('Made-up Client Took');
    const kickoff = String(steps.get('kickoff-call'));
    const took = await assign(the.selfAssigner, kickoff, the.selfAssigner.personId);
    expect(took.status, JSON.stringify(took.body)).toBe(200);
    expect(await openOn(kickoff)).toStrictEqual([]);
    await done(steps, 'welcome-email');
    expect(await openOn(kickoff)).toStrictEqual([the.selfAssigner.personId]);
  });
});
