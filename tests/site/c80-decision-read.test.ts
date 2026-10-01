// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 decision read: `live_correction.read` answers a correction's state, the
// approver who decided it by name (or null) and its version, and nothing
// else, to whoever may see the task's run (`run:read` at the correction's own
// party). Three real crossings, each beside a reader in scope who does see
// the correction, and each refusal compared byte for byte with the answer to
// an id that names nothing: another business, another client party in the
// same business, another person's correction under a live delegation.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, requestBody, type C80World } from './c80-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C80 decision read: DATABASE_URL is unset.');

let w: C80World;

const readAs = async (member: Member, correctionId: unknown, business = w.world.business) =>
  await executeRead(w.world.db.app, business, member.presented, {
    read: 'live_correction.read',
    correctionId,
  });

const readCode = (result: Awaited<ReturnType<typeof readAs>>): string =>
  isCommandRefusal(result) ? result.code : 'not-a-refusal';

const readAsAgent = async (correctionId: string, credential: string) =>
  await w.world.asAgent(
    { command: 'live_correction.read', operationId: randomUUID(), correctionId },
    credential,
  );

/** A correction `member` requested, with its id and version. */
const requested = async (member: Member, overrides: Readonly<Record<string, unknown>> = {}) => {
  const detail = detailOf(await w.request(member, overrides));
  return { id: String(detail['correctionId']), versionId: String(detail['versionId']) };
};

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c80World('c80read');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C80 decision read', () => {
  it('answers the state, the deciding approver by name and the version, and nothing else', async () => {
    await w.setApprover(w.ben.personId);
    const asked = await requested(w.ava);
    expect(await readAs(w.ava, asked.id)).toStrictEqual({
      ok: true,
      correction: {
        correctionId: asked.id,
        state: 'requested',
        approver: null,
        versionId: asked.versionId,
      },
    });
    expect(codeOf(await w.approve(w.ben, asked.id, asked.versionId))).toBe('not-a-refusal');
    expect(await readAs(w.ava, asked.id)).toStrictEqual({
      ok: true,
      correction: {
        correctionId: asked.id,
        state: 'approved',
        approver: 'ben',
        versionId: asked.versionId,
      },
    });
  });
});

describe.skipIf(serverUrl === undefined)('C80 decision read, another business', () => {
  it('answers another business’s correction exactly as an id that names nothing', async () => {
    const theirs = await requested(w.ava);
    expect(readCode(await readAs(w.ava, theirs.id))).toBe('not-a-refusal');
    const foreign = await readAs(w.eve, theirs.id, w.beta);
    expect(readCode(foreign)).toBe('NOT_FOUND');
    expect(foreign).toStrictEqual(await readAs(w.eve, randomUUID(), w.beta));
    expect(await w.stateOf(theirs.id)).toBe('requested');
  });
});

describe.skipIf(serverUrl === undefined)('C80 decision read, another client', () => {
  it('a grant on party B reads party B’s correction and nothing on party A', async () => {
    const onB = await requested(w.dee, { partyId: w.partyB });
    const onA = await requested(w.ava);
    expect(readCode(await readAs(w.dee, onB.id))).toBe('not-a-refusal');
    const crossed = await readAs(w.dee, onA.id);
    expect(readCode(crossed)).toBe('NOT_FOUND');
    expect(crossed).toStrictEqual(await readAs(w.dee, randomUUID()));
    expect(JSON.stringify(crossed)).not.toContain(onA.versionId);
    expect(await w.stateOf(onA.id)).toBe('requested');
  });
});

describe.skipIf(serverUrl === undefined)(
  'C80 decision read, another person under a delegation',
  () => {
    it('an agent reads the corrections of its delegated task and of no other', async () => {
      const picked = await w.world.pickUp(w.ava, 'the about page, read back');
      const made = await w.world.asAgent(
        { ...requestBody(w.partyA, picked.taskId), operationId: randomUUID() },
        picked.credential,
      );
      const own = String(detailOf(made)['correctionId']);
      const seen = await readAsAgent(own, picked.credential);
      expect(detailOf(seen)['correction']).toMatchObject({ correctionId: own, state: 'requested' });
      // Another person's correction, under another task of the same business.
      const others = await requested(w.cal);
      const crossed = await readAsAgent(others.id, picked.credential);
      expect(codeOf(crossed)).toBe('NOT_FOUND');
      expect(crossed).toStrictEqual(await readAsAgent(randomUUID(), picked.credential));
      expect(await w.stateOf(others.id)).toBe('requested');
    });
  },
);
