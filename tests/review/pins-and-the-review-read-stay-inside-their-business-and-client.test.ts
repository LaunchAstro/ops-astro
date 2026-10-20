// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- three crossings and the planted marker, read top to bottom */
//
// C35 (#2012), three crossings for pins and the review read: dee holds the review keys on
// client B only, eve holds them business-wide in another business, and an agent delegated by
// ava for task A acts for her on task A alone. Each crossing is refused with one answer, keeps
// nothing, and no refusal or read shows the planted pin's body, anchor or id.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { B_FILE, B_PAGE, c35World, spot, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 pin isolation: DATABASE_URL is unset.');

const MARKER = 'planted-pin-marker-9d1f';
const MARKER_SPOT = 'xywh=7,77,777,7';

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35piniso');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

async function capturedOn(taskId: string, pageUrl?: string, path?: string) {
  const opened = detailOf(
    await w.open(w.ava, pageUrl === undefined ? { taskId } : { taskId, pageUrl, path }),
  );
  expect(codeOf(await w.capture(w.ava, opened['revisionId']))).toBe('not-a-refusal');
  return { reviewId: String(opened['reviewId']), revisionId: String(opened['revisionId']) };
}

describe.skipIf(serverUrl === undefined)('C35 isolation', () => {
  it('C35 isolation for pins and the review read', async () => {
    const onA = await capturedOn(w.taskA);
    const onB = await capturedOn(w.taskB, B_PAGE, B_FILE);
    const planted = detailOf(
      await w.pin(w.ava, onA.revisionId, { body: MARKER, selector: [spot(MARKER_SPOT)] }),
    );
    expect(planted['commentId']).toEqual(expect.any(String));
    const alpha = w.world.business;
    const pins = await w.count('pins', alpha);
    const betaPins = await w.count('pins', w.beta);
    const answers: unknown[] = [];
    const seen = async <T>(answer: Promise<T>): Promise<T> => {
      const value = await answer;
      answers.push(value);
      return value;
    };

    // Another client in the same business: dee reaches client B's review and not client A's.
    // The door asks review:comment at the review's holder, as review.capture's does.
    expect(codeOf(await seen(w.pin(w.dee, onA.revisionId)))).toBe('SCOPE_NOT_GRANTED');
    expect(await seen(w.read(w.dee, onA.reviewId))).toMatchObject({ code: 'NOT_FOUND' });
    expect(codeOf(await w.pin(w.dee, onB.revisionId))).toBe('not-a-refusal');
    const deeRead = await seen(w.read(w.dee, onB.reviewId));
    if (!('review' in deeRead)) throw new Error('dee cannot read client B review');
    expect((deeRead.review as unknown as { readonly pins: unknown[] }).pins).toHaveLength(1);

    // Another business: eve's grant covers beta only, so alpha's revision is no revision.
    expect(codeOf(await seen(w.pin(w.eve, onA.revisionId, {}, w.beta)))).toBe('NOT_FOUND');
    expect(await seen(w.read(w.eve, onA.reviewId, w.beta))).toMatchObject({ code: 'NOT_FOUND' });

    // Another person's behalf: ava's delegation for task A pins nothing on client B's task.
    const credential = await w.world.db.app.withBusiness(alpha, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: w.world.agentActorId,
        delegatePersonId: w.ava.personId,
        mintedByActorId: w.ava.actorId,
        purpose: 'pin_on_task_a',
        collections: ['review'],
        actions: ['comment'],
        purposeScope: { kind: 'record', id: w.taskA },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(minted.refusal.code);
      return minted.value.credential;
    });
    const agentPin = await seen(
      w.world.asAgent(
        {
          command: 'review.pin_comment',
          operationId: randomUUID(),
          revisionId: onB.revisionId,
          width: 1480,
          selector: [spot()],
          body: 'not mine to pin',
          audience: 'internal',
        },
        credential,
      ),
    );
    expect(codeOf(agentPin)).toBe('DELEGATION_OUT_OF_PURPOSE');

    expect(await w.count('pins', alpha)).toBe(pins + 1);
    expect(await w.count('pins', w.beta)).toBe(betaPins);
    const shown = JSON.stringify(answers);
    for (const leak of [MARKER, MARKER_SPOT, String(planted['commentId'])]) {
      expect(shown).not.toContain(leak);
    }
  });
});
