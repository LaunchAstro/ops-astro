// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011): opening a review and asking its capture are `review:write` at the review's
// holder. A member holding the correction keys and no review key is refused at the door,
// and an agent working a pickup is refused too: its delegation reaches one task and never
// carries `review`. Each refusal stores nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { ABOUT, PAGE, c35World, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 refusal: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35deny');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35 review:write', () => {
  it('C35 refusal review:write', async () => {
    const opened = detailOf(await w.open(w.ava));
    const captures = await w.count('review_captures', w.world.business);
    const revisions = await w.count('review_revisions', w.world.business);

    // cal holds run:write and gate:decide business-wide, and no review key.
    expect(codeOf(await w.open(w.cal))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await w.capture(w.cal, opened['revisionId']))).toBe('SCOPE_NOT_GRANTED');

    // An agent on a pickup under party A, its delegating person holding review:write there.
    const picked = await w.pickUpUnder(w.ava, 'Review the about page', w.partyA);
    const asAgent = async (body: Readonly<Record<string, unknown>>) =>
      codeOf(await w.world.asAgent({ operationId: randomUUID(), ...body }, picked.credential));
    const open = { command: 'review.open', taskId: picked.taskId, pageUrl: PAGE, path: ABOUT };
    expect(await asAgent({ ...open, sourceRevision: 'rev-agent' })).toMatch(/^DELEGATION_/u);
    expect(await asAgent({ command: 'review.capture', revisionId: opened['revisionId'] })).toMatch(
      /^DELEGATION_/u,
    );

    expect(await w.count('review_revisions', w.world.business)).toBe(revisions);
    expect(await w.count('review_captures', w.world.business)).toBe(captures);
  });
});
