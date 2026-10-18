// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P1 (design v3, "The read path"): the worker reads its run's entry file
// through `definition.read` on the real agent door, then sends a
// [definition, task] turn whose definition part is the read's path, digest
// and text. The broker binds it by the text's hash and the run's own ledger
// row, and the provider's system message is the file, byte for byte.

import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { signedIn } from './run-stop-door-world.ts';
import {
  bytesOf,
  definitionPart,
  digestOf,
  ENTRY,
  pinnedWork,
  readOk,
  useDefinitionWorld,
} from './definition-world.ts';
import { sendTurn, settledOnce, systemOf } from './definition-turns.ts';
import { taskPart } from './turn-world.ts';

describe.skipIf(serverUrl === undefined)("a definition part from the run's own read", () => {
  useDefinitionWorld('defbinds');

  it('binds, settles, and is sent as the system message byte-equal to the file', async () => {
    const on = await pinnedWork('definition binds');
    const as = await signedIn();
    const read = await readOk(on, as);
    const bytes = bytesOf(ENTRY);
    expect(read).toMatchObject({ path: ENTRY, digest: digestOf(bytes), size: bytes.byteLength });
    const part = {
      ref: 'definition',
      path: read['path'],
      digest: read['digest'],
      text: read['text'],
    };
    expect(part).toEqual(definitionPart(ENTRY));
    // Mutation: bind refuses every definition part (R3's PROVENANCE_UNBOUND) -> red.
    const turn = await sendTurn(on, [part, await taskPart(on.work)], as);
    settledOnce(turn);
    const system = systemOf(turn);
    expect(system?.['role']).toBe('system');
    // Mutation: the system message rebuilt from anything but the read's text -> red.
    expect(Buffer.from(String(system?.['text']), 'utf8').equals(Buffer.from(bytes))).toBe(true);
  }, 60_000);
});
