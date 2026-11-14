// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 (#2016): a person whose proposal keys reach one client only (dee: `proposal:write` and
// `proposal:decide` on party B) files a change request from a client pin on party B's own
// review and decides it, and is recorded as its filer and decider. The isolation proof shows the
// same keys reach nothing of party A's; this is the positive half of that crossing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { B_FILE, B_PAGE, spot, underReview } from './c35-world.ts';
import { asClientPin } from './client-pin-seed.ts';
import { c57World, type C57World } from './c57-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C57 client-scoped keys: DATABASE_URL is unset.');

let w: C57World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c57World('c57own');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C57 keys on one client', () => {
  it("C57 a client-scoped holder files and decides on its own client's review", async () => {
    const onB = await underReview(w, 'a review of party B', {
      partyId: w.partyB,
      pageUrl: B_PAGE,
      path: B_FILE,
    });
    const pin = String(
      detailOf(await w.pin(w.ava, onB.revisionId, { selector: [spot('xywh=5,5,30,30')] }))[
        'commentId'
      ],
    );
    await asClientPin(w.world.db.admin, w.world.business, pin);

    const filed = await w.propose(w.dee, pin);
    expect(codeOf(filed)).toBe('not-a-refusal');
    const id = String(detailOf(filed)['changeRequestId']);
    const decided = await w.decide(w.dee, id, 'approve');
    expect(codeOf(decided)).toBe('not-a-refusal');
    expect(detailOf(decided)['state']).toBe('approved');

    const row = (await w.requests(w.world.business)).find((request) => request.id === id);
    expect(row?.party_id).toBe(w.partyB);
    expect(row?.proposed_by_person_id).toBe(w.dee.personId);
    expect(row?.decided_by_person_id).toBe(w.dee.personId);
  });
});
