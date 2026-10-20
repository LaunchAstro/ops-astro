// SPDX-License-Identifier: AGPL-3.0-only
//
// #1738, criterion 3 (U103's AW-10 outcomes on the new runner): the shipped
// worker's agent turn is cut, and the provider's lookup never gets through,
// so nobody can tell whether the call went out. The owner's task, read
// through the app's own client as the Agent pane reads it, is the story the
// pane asks them to pick one of three outcomes on (`UnknownOutcome`). "It happened" records the call as the effect at its
// maximum, with the owner's name, and the work finishes: the worker's next
// pass sends no second turn and hands nothing back. "Nothing happened" puts
// the hold back and the work resumes: the worker's next pass computes the
// plan again with the agent's runner and hands the output back for review.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { runStories, type RunStory } from '../../packages/ui/src/state/agent-run.ts';
import type { RunLineage } from '../../packages/ui/src/state/run-projection.ts';
import { tokenFor } from '../api/fixture.ts';
import { rows } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { attemptsOf, callsOf, droppedTurn, pass, shippedBroker } from './agent-drop-world.ts';
import type { Seam } from './compute-seam-world.ts';
import { door, noDatabase, s, useStopWorld, world } from './run-stop-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useStopWorld('u103out');

beforeAll(async () => {
  if (!noDatabase) await openBilling(s);
}, 60_000);

/** The owner's page client over the real door, signed in with the second factor. */
async function ownersPage(): Promise<OperationsClient> {
  const [business] = await rows<{ key: string }>(
    s,
    'select key from public.businesses where id = $1',
    [s.business],
  );
  const token = await tokenFor(s.decider.presented.subject, { secondFactor: true });
  const api = door(s.db.app, shippedBroker());
  return new OperationsClient({
    origin: 'http://api.test',
    businessKey: String(business?.key),
    signedIn: true,
    fetch: async (url, init) =>
      await api.fetch(
        new Request(url, {
          ...init,
          headers: { ...init?.headers, authorization: `Bearer ${token}` },
        }),
      ),
  });
}

/** The task's current run, as the Agent pane draws it from the owner's task read. */
async function storyOf(page: OperationsClient, taskId: string): Promise<RunStory | undefined> {
  const read = await page.read('task.read', { recordId: taskId });
  if (!('ok' in read)) throw new Error(`task.read refused ${JSON.stringify(read)}`);
  const task = (read.value as { task?: { proposals?: readonly RunLineage[] } }).task;
  return runStories(task?.proposals).find((story) => story.unknownAttempt !== null);
}

/** A cut turn the provider cannot answer for: after the pass, the outcome is a person's to say. */
async function unknownTurn(title: string): Promise<{ seam: Seam; attemptId: string }> {
  world.provider.lookupMode('unreachable');
  try {
    const { seam } = await droppedTurn('cut', title);
    await pass();
    const [attempt] = await attemptsOf(seam.taskId);
    expect(attempt).toMatchObject({ state: 'liability_unknown', held: 'held' });
    expect(await callsOf(seam.taskId)).toMatchObject([{ state: 'liability_unknown' }]);
    return { seam, attemptId: String(attempt?.['id']) };
  } finally {
    world.provider.lookupMode('honest');
  }
}

it("an unknown turn asks the owner to pick one of three, and 'it happened' records the effect and finishes the work", async () => {
  const { seam, attemptId } = await unknownTurn('u103 happened');
  const page = await ownersPage();
  const asked = await storyOf(page, seam.taskId);
  // The pane draws its three outcomes for exactly this (`surfaces/agent/unknown.tsx`).
  expect(asked).toMatchObject({
    state: 'unknown-outcome',
    word: 'Outcome unknown',
    unknownAttempt: { id: attemptId, heldMinor: expect.any(Number) },
  });

  const said = await page.mutate('budget.record_outcome', {
    recordId: seam.taskId,
    attemptId,
    outcome: 'happened',
  });
  expect('ok' in said, JSON.stringify(said)).toBe(true);
  expect(await callsOf(seam.taskId)).toMatchObject([
    {
      state: 'settled',
      actual: '500',
      outcome: 'happened',
      outcome_person_id: s.decider.personId,
    },
  ]);
  expect(await attemptsOf(seam.taskId)).toMatchObject([{ id: attemptId, state: 'settled' }]);
  expect(await storyOf(page, seam.taskId)).toBeUndefined();

  // The work is finished: the worker's next pass makes no second turn and hands nothing back.
  const before = seam.log.length;
  await seam.worker.applyOnce(seam.taskId);
  const after = seam.log.slice(before).map((sent) => sent.verb);
  expect(after).not.toContain('model.call');
  expect(after).not.toContain('task.handback');
}, 180_000);

it("'nothing happened' puts the hold back and the agent's runner resumes the work to review", async () => {
  const { seam, attemptId } = await unknownTurn('u103 nothing');
  const page = await ownersPage();
  const said = await page.mutate('budget.record_outcome', {
    recordId: seam.taskId,
    attemptId,
    outcome: 'nothing_happened',
  });
  expect('ok' in said, JSON.stringify(said)).toBe(true);
  expect(await callsOf(seam.taskId)).toMatchObject([
    { state: 'released', outcome: 'nothing_happened', outcome_person_id: s.decider.personId },
  ]);

  const resumed = await seam.worker.applyOnce(seam.taskId);
  expect(
    resumed,
    JSON.stringify(seam.log.map(({ verb, status }) => ({ verb, status }))),
  ).toMatchObject({
    handedBack: { taskId: seam.taskId },
  });
  expect(await callsOf(seam.taskId)).toMatchObject([
    { state: 'released', outcome: 'nothing_happened' },
    { state: 'settled', operation_key: 'model.agent_turn' },
  ]);
}, 180_000);
