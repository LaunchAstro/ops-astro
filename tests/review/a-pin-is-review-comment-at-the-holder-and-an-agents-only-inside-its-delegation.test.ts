// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each refusal beside the key it lacks, read top to bottom */
//
// C35 (#2012): `review.pin_comment` is `review:comment` at the review's holder. A member
// without the key is refused at the door; an agent pins only inside a delegation that carries
// `review:comment` for the review's own task, and only a team note. Every attempt leaves its
// audit row under the command's name, and a refusal keeps no pin.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { B_FILE, B_PAGE, c35World, spot, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 pin refusal: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35pindeny');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** A credential for the fixture's agent, delegated by ava for `taskId` with these keys. */
async function delegated(
  taskId: string,
  actions: readonly ('comment' | 'write' | 'read')[],
): Promise<string> {
  return await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: w.ava.personId,
      mintedByActorId: w.ava.actorId,
      // One live delegation per purpose: each test credential names its own.
      purpose: `pin_${actions.join('_')}_${taskId.slice(0, 8)}`,
      collections: ['review'],
      actions: [...actions],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mintDelegation refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
}

const pinBody = (revisionId: unknown, overrides: Readonly<Record<string, unknown>> = {}) => ({
  command: 'review.pin_comment',
  operationId: randomUUID(),
  revisionId,
  width: 1480,
  selector: [spot()],
  body: 'The agent found this heading cut off',
  audience: 'internal',
  ...overrides,
});

async function capturedOn(taskId: string, pageUrl?: string, path?: string): Promise<string> {
  const opened = detailOf(
    await w.open(w.ava, pageUrl === undefined ? { taskId } : { taskId, pageUrl, path }),
  );
  expect(codeOf(await w.capture(w.ava, opened['revisionId']))).toBe('not-a-refusal');
  return String(opened['revisionId']);
}

/** The newest audit row's time in alpha, read on the database's clock. */
const auditMark = async (): Promise<string> =>
  (
    await w.world.db.admin.execute<{ readonly at: string }>(
      `select coalesce(max(occurred_at), 'epoch')::text as at from public.audit_events
        where business_id = $1`,
      [w.world.business],
    )
  )[0]?.at ?? 'epoch';

const auditOf = async (since: string) =>
  (
    await w.world.db.admin.execute<{
      readonly command: string;
      readonly refusal_code: string | null;
    }>(
      `select command, refusal_code from public.audit_events
        where business_id = $1 and command = 'review.pin_comment' and occurred_at > $2
        order by occurred_at, id`,
      [w.world.business, since],
    )
  ).map((row) => [row.command, row.refusal_code]);

describe.skipIf(serverUrl === undefined)('C35 review:comment', () => {
  it('C35 refusal review:comment', async () => {
    const onA = await capturedOn(w.taskA);
    const onB = await capturedOn(w.taskB, B_PAGE, B_FILE);
    const pins = await w.count('pins', w.world.business);

    // cal holds the correction keys and no review key.
    expect(codeOf(await w.pin(w.cal, onA))).toBe('SCOPE_NOT_GRANTED');

    // A pickup's delegation carries `task` alone.
    const picked = await w.pickUpUnder(w.ava, 'Look over the about page', w.partyA);
    expect(codeOf(await w.world.asAgent(pinBody(onA), picked.credential))).toMatch(/^DELEGATION_/u);

    // A review delegation without `comment`, and one for task A pinning on task B's review.
    const writeOnly = await delegated(w.taskA, ['write']);
    expect(codeOf(await w.world.asAgent(pinBody(onA), writeOnly))).toMatch(/^DELEGATION_/u);
    const forA = await delegated(w.taskA, ['comment']);
    expect(codeOf(await w.world.asAgent(pinBody(onB), forA))).toBe('DELEGATION_OUT_OF_PURPOSE');
    // A stray recordId naming the delegated task does not steer the check: the body is refused.
    expect(codeOf(await w.world.asAgent(pinBody(onB, { recordId: w.taskA }), forA))).toBe(
      'COMMAND_BODY_INVALID',
    );
    // Inside its delegation, the agent writes a team note and never a client's pin.
    expect(codeOf(await w.world.asAgent(pinBody(onA, { audience: 'client' }), forA))).toBe(
      'AUDIENCE_NOT_PERMITTED',
    );
    expect(await w.count('pins', w.world.business)).toBe(pins);

    const pinned = await w.world.asAgent(pinBody(onA), forA);
    expect(codeOf(pinned)).toBe('not-a-refusal');
    const [row] = await w.world.db.admin.execute<{
      readonly author: string;
      readonly on_behalf_of: string;
      readonly audience: string;
    }>(
      `select data->>'author' as author, data->>'on_behalf_of' as on_behalf_of,
              data->>'audience' as audience
         from public.records where business_id = $1 and id = $2`,
      [w.world.business, detailOf(pinned)['commentId']],
    );
    expect(row).toStrictEqual({
      author: w.world.agentActorId,
      on_behalf_of: w.ava.personId,
      audience: 'internal',
    });
    expect(await w.count('pins', w.world.business)).toBe(pins + 1);
  });

  it('C35 audit readback (pinned comment created)', async () => {
    const revisionId = await capturedOn(w.taskA);
    const since = await auditMark();
    expect(codeOf(await w.pin(w.ava, revisionId))).toBe('not-a-refusal');
    expect(codeOf(await w.pin(w.cal, revisionId))).toBe('SCOPE_NOT_GRANTED');
    expect(await auditOf(since)).toStrictEqual([
      ['review.pin_comment', null],
      ['review.pin_comment', 'SCOPE_NOT_GRANTED'],
    ]);
  });
});
