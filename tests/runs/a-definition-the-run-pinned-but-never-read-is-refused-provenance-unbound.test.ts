// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P6 (design v3, bind step 2): the broker binds a definition part by
// the run's ledger, never by its pin's manifest. The run pinned the file and
// the part carries its genuine bytes and digest, but the run never read it,
// so there is no ledger row: refused `PROVENANCE_UNBOUND` before any hold.

import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { signedIn } from './run-stop-door-world.ts';
import {
  definitionPart,
  ENTRY,
  ledgerOf,
  pinnedWork,
  useDefinitionWorld,
} from './definition-world.ts';
import { beforeTurn, refusedBeforeAnyHold, sendTurn } from './definition-turns.ts';
import { taskPart } from './turn-world.ts';

describe.skipIf(serverUrl === undefined)('a definition the run pinned but never read', () => {
  useDefinitionWorld('defunread');

  it('is refused PROVENANCE_UNBOUND before any hold, its bytes and digest genuine', async () => {
    const on = await pinnedWork('definition pinned, never read');
    expect(await ledgerOf(on.runId)).toBe(0);
    const before = await beforeTurn(on);
    // Mutation: look up the pin's manifest instead of the ledger -> binds, red.
    const sent = await sendTurn(
      on,
      [definitionPart(ENTRY), await taskPart(on.work)],
      await signedIn(),
    );
    await refusedBeforeAnyHold(on, sent, 'PROVENANCE_UNBOUND', before);
  }, 60_000);
});
