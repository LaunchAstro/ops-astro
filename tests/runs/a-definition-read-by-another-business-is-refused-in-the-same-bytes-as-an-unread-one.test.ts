// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P8 (design v3, bind step 2 and its redundant fences): a definition
// another business read is no provenance here. Two businesses of one
// installation pin the same file from the same folder; the other business's
// run reads it through its own agent door; this business's turn names it with
// the genuine bytes and digest and is refused `PROVENANCE_UNBOUND` before any
// hold, in the same bytes as a definition its run never read, with no id of
// the other business in the body. This proves the crossing's outcome; the
// business predicate in the lookup is a redundant fence behind `run_id`.

import { beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { rows, seedSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { s, signedIn } from './run-stop-door-world.ts';
import { ENTRY, ledgerOf, pinnedWork, readOk, useDefinitionWorld } from './definition-world.ts';
import { turnOnUnread } from './definition-turns.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

describe.skipIf(serverUrl === undefined)('a definition another business read', () => {
  useDefinitionWorld('defotherbusiness');

  let other: Schedules;
  let otherKey: string;

  beforeAll(async () => {
    other = await seedSchedules(s.db, 'defotherbusiness-other', 1_000_000);
    const [business] = await rows<{ key: string }>(
      s,
      'select key from public.businesses where id = $1',
      [other.business],
    );
    otherKey = String(business?.key);
  }, 120_000);

  it('is refused in the same bytes as an unread one, with no foreign id', async () => {
    const unread = await turnOnUnread('definition never read here');
    const theirs = await pinnedWork('definition read by the other business', [ENTRY], other);
    await readOk(theirs, await signedIn(other), ENTRY, otherKey);
    expect(await ledgerOf(theirs.runId, other)).toBe(1);
    // No one mutation turns this red: `run_id`, the business predicate and RLS each fence it (design, redundant fences).
    const crossing = await turnOnUnread('definition named from the other business');
    expect(crossing.body).toEqual(unread.body);
    const text = JSON.stringify(crossing.body);
    expect(text).not.toContain(other.business);
    expect(text).not.toContain(theirs.runId);
    expect(text).not.toMatch(UUID);
  }, 90_000);
});
