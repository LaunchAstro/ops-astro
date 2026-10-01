// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 decision read: `live_correction.read` answers a correction's state, the
// approver who decided it by name (or null) and its version, and nothing
// else, to whoever may request it (`run:write` at the correction's own party,
// ORCH33). Four real crossings, each beside a reader in scope who does see
// the correction, and each refusal compared byte for byte with the answer to
// an id that names nothing: another business, another client party in the
// same business, a client outside the business, and an agent under another
// person's live delegation, which reads none (the read is never an agent's).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, requestBody, type C80World } from './c80-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { grantTo, shareWithClient, type Member } from '../commands/fixture.ts';

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
    it('an agent under a live delegation reads no decision, its own task’s included', async () => {
      const picked = await w.world.pickUp(w.ava, 'the about page, read back');
      const made = await w.world.asAgent(
        { ...requestBody(w.partyA, picked.taskId), operationId: randomUUID() },
        picked.credential,
      );
      const own = String(detailOf(made)['correctionId']);
      // The delegating person reads it: the agent's refusal is the delegation's.
      expect(readCode(await readAs(w.ava, own))).toBe('not-a-refusal');
      const others = await requested(w.cal);
      const onOwn = await readAsAgent(own, picked.credential);
      expect(codeOf(onOwn)).toBe('DELEGATION_EXCLUDES_OPERATION');
      expect(await readAsAgent(others.id, picked.credential)).toStrictEqual(onOwn);
      expect(await readAsAgent(randomUUID(), picked.credential)).toStrictEqual(onOwn);
      expect(JSON.stringify(onOwn)).not.toContain(own);
      expect(await w.stateOf(others.id)).toBe('requested');
    });
  },
);

describe.skipIf(serverUrl === undefined)('C80 decision read, run:write alone', () => {
  it('a member holding only run:write at party A reads back their own correction', async () => {
    const fay = await w.world.decider('fay');
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, fay, 'write', { kind: 'party', id: w.partyA }, false, 'run');
    });
    const asked = await requested(fay);
    expect(readCode(await readAs(fay, asked.id))).toBe('not-a-refusal');
  });
});

describe.skipIf(serverUrl === undefined)('C80 decision read, a client outside the business', () => {
  it('a client holding a record share reads a correction exactly as an id that names nothing', async () => {
    const asked = await requested(w.ava);
    const client = await shareWithClient(w.world.db.app, w.world.business, w.ava, w.taskA);
    // Even a run:write at the correction's party reads nothing for a client.
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, client, 'write', { kind: 'party', id: w.partyA }, false, 'run');
    });
    const theirs = await readAs(client, asked.id);
    expect(readCode(theirs)).toBe('NOT_FOUND');
    expect(theirs).toStrictEqual(await readAs(client, randomUUID()));
  });
});

describe.skipIf(serverUrl === undefined)('C80 decision read, no run:write', () => {
  it('a member holding run:write nowhere is refused alike for a real and an unknown id', async () => {
    const asked = await requested(w.ava);
    const refusedReal = await readAs(w.admin, asked.id);
    expect(readCode(refusedReal)).toBe('SCOPE_NOT_GRANTED');
    expect(refusedReal).toStrictEqual(await readAs(w.admin, randomUUID()));
  });
});
