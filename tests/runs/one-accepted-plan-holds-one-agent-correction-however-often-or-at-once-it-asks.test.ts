// SPDX-License-Identifier: AGPL-3.0-only
//
// #1624 R8a (#1717, owner ruling Q2): an accepted plan version holds one
// agent-drafted correction. The agent asks at the real door under the
// delegation its pickup minted; the plan version is the server's own read of
// that pickup's lease, never a field the agent sends. Asked again under a new
// operation id, as a second attempt on the same plan would, the door answers
// the first correction and stores nothing. Two asks at once on separate
// connections store one row between them. A new version of the plan is new
// work, and holds its own.

import { beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { createTask } from '../runtime/schedules-harness.ts';
import {
  correctionsOn,
  OWN_PAGE,
  ownSiteOf,
  requestAsAgent,
  requestOf,
  workOn,
  type Detail,
} from './agent-draft-world.ts';
import { s, useStopWorld, type Answer } from './run-stop-world.ts';

useStopWorld('r8aoneplan');

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await ownSiteOf(s, OWN_PAGE);
}, 180_000);

const correctionOf = (answer: Answer): unknown =>
  (answer.body['detail'] as Detail | undefined)?.['correctionId'];

const OTHER_WORDS = { word: 'studio', replacement: 'practice' } as const;

describe.skipIf(serverUrl === undefined)("an accepted plan's agent correction", () => {
  it("is the first attempt's when the plan asks again under a new operation", async () => {
    const work = await workOn(await createTask(s, 'asked twice'));
    const first = await requestAsAgent(work, requestOf(work.taskId));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await requestAsAgent(work, { ...requestOf(work.taskId), ...OTHER_WORDS });
    expect(again.status, JSON.stringify(again.body)).toBe(200);

    expect(correctionOf(again)).toBe(correctionOf(first));
    const stored = await correctionsOn(work.taskId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ word: 'Townsvile', replacement: 'Townsville' });
  }, 120_000);

  it('is one row when two asks arrive at once', async () => {
    const work = await workOn(await createTask(s, 'asked at once'));
    const answers = await Promise.all([
      requestAsAgent(work, requestOf(work.taskId)),
      requestAsAgent(work, { ...requestOf(work.taskId), ...OTHER_WORDS }),
    ]);
    for (const answer of answers) expect(answer.status, JSON.stringify(answer.body)).toBe(200);

    expect(correctionOf(answers[0])).toBe(correctionOf(answers[1]));
    expect(await correctionsOn(work.taskId)).toHaveLength(1);
  }, 120_000);

  it("is the new version's own once the plan is proposed again", async () => {
    const work = await workOn(await createTask(s, 'a plan revised'));
    const first = await requestAsAgent(work, requestOf(work.taskId));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const revised = await workOn(work.taskId, String(work.proposal['lineageId']));
    const second = await requestAsAgent(revised, requestOf(work.taskId));
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    expect(correctionOf(second)).not.toBe(correctionOf(first));
    expect(await correctionsOn(work.taskId)).toHaveLength(2);
  }, 120_000);
});
