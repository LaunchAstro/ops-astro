// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's operands as sent. A UUID in upper case names the same person, version
// or task as its lower-case spelling and gets the same decision; a correction
// id that is no UUID names no correction, as a fabricated one does; and request
// text the stores cannot hold (a NUL) is refused by name on the person and the
// agent route, so none of them becomes a database fault.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { c80World, requestBody, type C80World } from './c80-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C80 identifiers and text: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

/** A fresh correction requested by ava at party A: its id and version. */
async function requested(): Promise<{ readonly id: string; readonly versionId: string }> {
  const detail = detailOf(await w.request(w.ava));
  return { id: String(detail['correctionId']), versionId: String(detail['versionId']) };
}

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c80World('c80ident');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C80 identifiers in either case', () => {
  it('lets the approver configured by an upper-case id approve', async () => {
    expect(codeOf(await w.setApprover(w.ben.personId.toUpperCase()))).toBe('not-a-refusal');
    const one = await requested();
    expect(codeOf(await w.approve(w.ben, one.id, one.versionId))).toBe('not-a-refusal');
    expect(await w.stateOf(one.id)).toBe('approved');
  });

  it('approves the version named by its upper-case id', async () => {
    await w.setApprover(w.ben.personId);
    const one = await requested();
    const approved = await w.approve(w.ben, one.id, one.versionId.toUpperCase());
    expect(codeOf(approved)).toBe('not-a-refusal');
    expect(await w.stateOf(one.id)).toBe('approved');
  });

  it('takes an agent request on its own task named in upper case', async () => {
    const picked = await w.pickUpUnder(w.ava, 'upper case task', w.partyA);
    const sent = {
      ...requestBody(w.partyA.toUpperCase(), picked.taskId.toUpperCase()),
      operationId: randomUUID(),
    };
    expect(codeOf(await w.world.asAgent(sent, picked.credential))).toBe('not-a-refusal');
  });
});

describe.skipIf(serverUrl === undefined)(
  'C80 operands that name nothing or cannot be stored',
  () => {
    it('answers a malformed correction id as it answers a fabricated one', async () => {
      const { versionId } = await requested();
      expect(codeOf(await w.approve(w.ben, 'not-a-uuid', versionId))).toBe('NOT_FOUND');
      expect(codeOf(await w.approve(w.ben, randomUUID(), versionId))).toBe('NOT_FOUND');
    });

    it('refuses a NUL in the request text by name on the person and the agent route', async () => {
      const before = await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.live_corrections',
      );
      const asPerson = await w.request(w.ava, { baseRevision: 'rev-1\u0000' });
      expect(codeOf(asPerson)).toBe('FIELD_VALUE_INVALID');
      expect(isCommandRefusal(asPerson) ? asPerson.names : []).toStrictEqual(['baseRevision']);
      const picked = await w.pickUpUnder(w.ava, 'nul text', w.partyA);
      const sent = {
        ...requestBody(w.partyA, picked.taskId),
        baseRevision: 'rev-1\u0000',
        operationId: randomUUID(),
      };
      expect(codeOf(await w.world.asAgent(sent, picked.credential))).toBe('FIELD_VALUE_INVALID');
      const after = await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.live_corrections',
      );
      expect(after).toStrictEqual(before);
    });
  },
);
