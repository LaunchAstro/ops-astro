// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2114, Copilot thread on review-pin.ts:246, DIRECTOR ANSWER 2 Nov 17:50Z). An agent's pin
// names its task through `revisionId`, not `recordId`. A replay of a stored pin is asked again
// on the task the body names; with no `recordId` that check fell back to the presenting
// delegation's own task, so the same agent, presenting a delegation for task B, replayed a pin
// made on task A and was handed A's stored task and comment ids. The replay is judged on the
// revision's own task: out of purpose, and nothing of the stored answer goes back.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35World, spot, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35pinreplay');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** A credential for the fixture's agent, delegated by ava for `taskId` with `review:comment`. */
const delegatedFor = async (taskId: string): Promise<string> =>
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: w.ava.personId,
      mintedByActorId: w.ava.actorId,
      purpose: `pin_replay_${taskId.slice(0, 8)}`,
      collections: ['review'],
      actions: ['comment'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mintDelegation refused ${minted.refusal.code}`);
    return minted.value.credential;
  });

describe.skipIf(serverUrl === undefined)('a pin replayed under another task delegation', () => {
  it('is refused out of purpose and hands back none of the first task ids', async () => {
    const opened = detailOf(await w.open(w.ava, { taskId: w.taskA }));
    expect(codeOf(await w.capture(w.ava, opened['revisionId']))).toBe('not-a-refusal');
    const body = {
      command: 'review.pin_comment',
      operationId: randomUUID(),
      revisionId: opened['revisionId'],
      width: 1480,
      selector: [spot()],
      body: 'A pin made on task A',
      audience: 'internal',
    };
    const first = await w.world.asAgent(body, await delegatedFor(w.taskA));
    expect(codeOf(first)).toBe('not-a-refusal');
    const commentId = String(detailOf(first)['commentId']);

    const replayed = await w.world.asAgent(body, await delegatedFor(w.taskB));
    const answer = JSON.stringify(replayed);
    expect({
      code: codeOf(replayed),
      namesTaskA: answer.includes(w.taskA),
      namesComment: answer.includes(commentId),
    }).toStrictEqual({ code: 'DELEGATION_OUT_OF_PURPOSE', namesTaskA: false, namesComment: false });
  });
});
