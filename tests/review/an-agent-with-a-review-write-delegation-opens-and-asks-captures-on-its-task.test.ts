// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2103, Sol's S2061-5 proof): an agent holding a live `review:write` delegation minted for
// one task opens a review on that task and asks its revision's captures, as the delegating
// person could. The mint and its task-scoped authority check are confirmed first, so a refusal
// here is the agent entry's, never the delegation's.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDelegatedAuthority,
  mintDelegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35World, PAGE, ABOUT, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 delegated review: DATABASE_URL is unset.');

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35delegated');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35 review:write under a delegation', () => {
  it('an agent with a live review:write delegation opens and asks captures within its task', async () => {
    const minted = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      const result = await mintDelegation(tx, {
        agentActorId: w.world.agentActorId,
        delegatePersonId: w.ava.personId,
        mintedByActorId: w.ava.actorId,
        purpose: 'review_the_bound_page',
        collections: ['review'],
        actions: ['write'],
        purposeScope: { kind: 'record', id: w.taskA },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.refusal.code);
      const authority = await checkDelegatedAuthority(tx, result.value.delegation, {
        collection: 'review',
        action: 'write',
        scope: { kind: 'record', id: w.taskA },
      });
      expect(authority.ok).toBe(true);
      return result.value;
    });
    const opened = await w.world.asAgent(
      {
        command: 'review.open',
        operationId: randomUUID(),
        taskId: w.taskA,
        pageUrl: PAGE,
        path: ABOUT,
        sourceRevision: 'agent-rev-1',
      },
      minted.credential,
    );
    expect.soft(codeOf(opened), 'open within the authorised task').toBe('not-a-refusal');
    const byPerson = detailOf(await w.open(w.ava));
    const capture = await w.world.asAgent(
      { command: 'review.capture', operationId: randomUUID(), revisionId: byPerson['revisionId'] },
      minted.credential,
    );
    expect.soft(codeOf(capture), 'capture within the authorised task').toBe('not-a-refusal');
  });
});
