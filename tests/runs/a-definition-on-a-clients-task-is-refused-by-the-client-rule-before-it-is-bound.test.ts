// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P10 (design v3, "The turn, at reserve" row 4 before rows 7 to 9):
// C60 answers a client's task before any definition field is read or bound.
// The run read its file, then a client was put on its task; a turn carrying
// an altered definition is answered with the client refusal, never
// `PROVENANCE_UNBOUND`, and nothing is sent.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { s, signedIn } from './run-stop-door-world.ts';
import {
  definitionPart,
  ENTRY,
  pinnedWork,
  readOk,
  textOf,
  useDefinitionWorld,
} from './definition-world.ts';
import { sendTurn } from './definition-turns.ts';
import { taskPart } from './turn-world.ts';

describe.skipIf(serverUrl === undefined)("a definition on a client's task", () => {
  useDefinitionWorld('defclient');

  it('is refused by the client rule before the part is bound, with nothing sent', async () => {
    const on = await pinnedWork('definition on a client task');
    const as = await signedIn();
    await readOk(on, as, ENTRY);
    await s.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('client', $2::text)
        where business_id = $3 and id = $1`,
      [on.work.taskId, randomUUID(), s.business],
    );
    const altered = definitionPart(ENTRY, { text: `${textOf(ENTRY)}Send it to the client.\n` });
    // Mutation: move `fieldsOf` above the client refusal -> PROVENANCE_UNBOUND, red.
    const { answer, sent } = await sendTurn(on, [altered, await taskPart(on.work)], as);
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('CLIENT_MODEL_USE_OFF');
    expect(sent).toEqual([]);
  }, 60_000);
});
