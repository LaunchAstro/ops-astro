// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P9 (design v3, bind step 2, `path = $3`): the ledger row binds a
// definition by the path the run read as well as its digest. The run read
// `AGENTS.md`; a part carrying those very bytes and that digest under another
// spelling of the path (`./AGENTS.md`, `agents.md`, `AGENTS.md/`,
// `docs/AGENTS.md`) is refused `PROVENANCE_UNBOUND` before any hold.

import { describe, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { signedIn } from './run-stop-door-world.ts';
import {
  definitionPart,
  ENTRY,
  pinnedWork,
  readOk,
  useDefinitionWorld,
} from './definition-world.ts';
import { beforeTurn, refusedBeforeAnyHold, sendTurn } from './definition-turns.ts';
import { taskPart } from './turn-world.ts';

const SPELLINGS = ['./AGENTS.md', 'agents.md', 'AGENTS.md/', 'docs/AGENTS.md'] as const;

describe.skipIf(serverUrl === undefined)('a definition naming a path the run did not read', () => {
  useDefinitionWorld('defpath');

  it.each(SPELLINGS)(
    "%s, with AGENTS.md's bytes and digest: refused PROVENANCE_UNBOUND before any hold",
    async (spelling) => {
      const on = await pinnedWork(`definition path ${spelling}`);
      const as = await signedIn();
      await readOk(on, as, ENTRY);
      const before = await beforeTurn(on);
      // Mutation: drop `path = $3` from the ledger lookup -> binds on AGENTS.md's row, red.
      const part = definitionPart(ENTRY, { path: spelling });
      const sent = await sendTurn(on, [part, await taskPart(on.work)], as);
      await refusedBeforeAnyHold(on, sent, 'PROVENANCE_UNBOUND', before);
    },
    60_000,
  );
});
