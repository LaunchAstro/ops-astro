// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 separation on replay. One agent actor works for two people at two
// clients of one business: a pickup for ava on a task at client A, then, once
// that delegation has ended, a pickup for dee (run:write at client B only) on a
// task at client B. The request made under the first delegation is replayed,
// same body and operationId, under the second. The receipt goes back only to a
// delegation that could make that request now; the second is refused, and
// none of the first request's identifiers or digest reach it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, requestBody, type C80World } from './c80-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C80 agent replay: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c80World('c80replay');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)(
  'C80 agent request replayed under another delegation',
  () => {
    it('refuses the replay to a later delegation for another person at another client', async () => {
      const forAva = await w.pickUpUnder(w.ava, 'client A page', w.partyA);
      const sent = { ...requestBody(w.partyA, forAva.taskId), operationId: randomUUID() };
      const first = detailOf(await w.world.asAgent(sent, forAva.credential));
      const correctionId = String(first['correctionId']);
      // The same delegation is handed its own receipt back.
      const again = await w.world.asAgent(sent, forAva.credential);
      expect(detailOf(again)['correctionId']).toBe(correctionId);

      await w.world.revokeDelegation(String(forAva.detail['delegationId']));
      const forDee = await w.pickUpUnder(w.dee, 'client B page', w.partyB);
      const replayed = await w.world.asAgent(sent, forDee.credential);
      expect(codeOf(replayed)).toBe('DELEGATION_OUT_OF_PURPOSE');
      const shown = JSON.stringify(replayed);
      expect(shown).not.toContain(correctionId);
      expect(shown).not.toContain(String(first['versionId']));
      expect(shown).not.toContain(String(first['versionDigest']));
    });
  },
);
