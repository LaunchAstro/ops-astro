// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P7 (design v3, bind step 2, `run_id = $2`): a definition another run
// of this business read is no provenance for this run. Both runs pin the same
// file; the other run reads it; this run's turn names it with the genuine
// bytes and digest and is refused `PROVENANCE_UNBOUND` before any hold, in
// the same bytes as a definition this run pinned and never read, naming
// nothing of the other run.

import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { signedIn } from './run-stop-door-world.ts';
import { ledgerOf, pinnedWork, readOk, useDefinitionWorld } from './definition-world.ts';
import { turnOnUnread } from './definition-turns.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

describe.skipIf(serverUrl === undefined)('a definition another run of the business read', () => {
  useDefinitionWorld('defotherrun');

  it('is refused in the same bytes as an unread one, and names nothing of the other run', async () => {
    const unread = await turnOnUnread('definition never read');
    const theirs = await pinnedWork('definition read by another run');
    await readOk(theirs, await signedIn());
    expect(await ledgerOf(theirs.runId)).toBe(1);
    // Mutation: drop `run_id = $2` from the ledger lookup -> binds on the other run's row, red.
    const crossing = await turnOnUnread('definition named from another run');
    expect(crossing.body).toEqual(unread.body);
    const text = JSON.stringify(crossing.body);
    expect(text).not.toContain(theirs.runId);
    expect(text).not.toContain(theirs.work.taskId);
    expect(text).not.toMatch(UUID);
  }, 90_000);
});
