// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2075, Sol S2165-4): the carry keeps the operation identity the agent envelope
// accepted, which is text (`OPERATION_ID`), not only a UUID. A carry under `sol-carry-0001`
// writes its one carry and stores that identity as given; before the fix the carry's own
// column refused it with a database error and wrote nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { OPERATION_ID } from '../../packages/core-commands/src/commands/register-store.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { c35World, type C35World } from './c35-world.ts';
import { agentLogin } from './c35-landing.ts';
import { carriesOnto, landPage, landedReview, must, nextRevision, pinOn } from './c35-x-carry.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X carry operation id: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35xopid');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const PAGE = { text: 'Book a visit today.', document: 'a' };

describe.skipIf(serverUrl === undefined)('C35-X carry operation identity', () => {
  it('a carry under a text operation id the envelope accepts writes its carry and keeps the id', async () => {
    const { reviewed, lease } = await landedReview(w, 'Carry under a text operation id', PAGE);
    const commentId = await pinOn(w, reviewed.revisionId);
    const next = await nextRevision(w, reviewed);
    await landPage(w, lease, next, PAGE);
    const operationId = 'sol-carry-0001';
    expect(OPERATION_ID.test(operationId)).toBe(true);

    const result = (await executeAgentCommand(
      w.world.db.app,
      w.world.business,
      agentLogin(w),
      lease.credential,
      {
        command: 'review.carry_pins',
        operationId,
        leaseId: lease.leaseId,
        fence: lease.fence,
        revisionId: next,
      } as never,
    )) as CommandResult;

    expect(must(result, 'review.carry_pins')).toMatchObject({ moved: 1, lost: 0 });
    const carries = await carriesOnto(w, next);
    expect(carries).toHaveLength(1);
    expect(carries[0]).toMatchObject({ comment_id: commentId, operation_id: operationId });
  }, 120_000);
});
