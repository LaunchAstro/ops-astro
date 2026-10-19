// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each refusal beside the key it lacks, read top to bottom */
//
// C57 (#2016): filing is `proposal:write` and deciding is `proposal:decide`, each at the
// review's client. An agent credential never decides, whatever its delegation carries. A
// request is decided once. Every attempt leaves its audit row under the command's name.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c57World, type C57World } from './c57-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C57 decisions: DATABASE_URL is unset.');

let w: C57World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c57World('c57decide');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const filed = async (): Promise<string> => {
  const { clientPin } = await w.pins();
  return String(detailOf(await w.propose(w.ava, clientPin))['changeRequestId']);
};

const stateOf = async (id: string) =>
  (await w.requests(w.world.business)).find((row) => row.id === id);

const auditMark = async (): Promise<string> =>
  (
    await w.world.db.admin.execute<{ readonly at: string }>(
      `select coalesce(max(occurred_at), 'epoch')::text as at from public.audit_events
        where business_id = $1`,
      [w.world.business],
    )
  )[0]?.at ?? 'epoch';

const auditOf = async (since: string) =>
  (
    await w.world.db.admin.execute<{
      readonly command: string;
      readonly refusal_code: string | null;
    }>(
      `select command, refusal_code from public.audit_events
        where business_id = $1 and command like 'review.%_change' and occurred_at > $2
        order by occurred_at, id`,
      [w.world.business, since],
    )
  ).map((row) => [row.command, row.refusal_code]);

describe.skipIf(serverUrl === undefined)('C57 deciding a change request', () => {
  it('C57 refusal proposal:write', async () => {
    const { clientPin } = await w.pins();
    // cal holds no proposal key.
    expect(codeOf(await w.propose(w.cal, clientPin))).toBe('SCOPE_NOT_GRANTED');
    expect(await w.requests(w.world.business)).toHaveLength(0);
  });

  it('C57 refusal proposal:decide', async () => {
    const id = await filed();
    // ben files but does not decide; cal holds neither key.
    expect(codeOf(await w.decide(w.ben, id, 'approve'))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await w.decide(w.cal, id, 'refuse'))).toBe('SCOPE_NOT_GRANTED');
    expect((await stateOf(id))?.state).toBe('proposed');
    expect(codeOf(await w.decide(w.ava, id, 'apply'))).toBe('FIELD_VALUE_INVALID');
    expect((await stateOf(id))?.state).toBe('proposed');
  });

  it('C57 agent approval refused', async () => {
    const id = await filed();
    const credential = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: w.world.agentActorId,
        delegatePersonId: w.ava.personId,
        mintedByActorId: w.ava.actorId,
        purpose: `decide_${id.slice(0, 8)}`,
        collections: ['proposal'],
        actions: ['write', 'decide'],
        purposeScope: { kind: 'record', id: w.taskA },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`mintDelegation refused ${minted.refusal.code}`);
      return minted.value.credential;
    });
    const asked = await w.world.asAgent(
      {
        command: 'review.decide_change',
        operationId: randomUUID(),
        changeRequestId: id,
        decision: 'approve',
      },
      credential,
    );
    expect(codeOf(asked)).toMatch(/^DELEGATION_/u);
    expect((await stateOf(id))?.state).toBe('proposed');
  });

  it('C57 a request is decided once, by the person who decides it', async () => {
    const approved = await filed();
    expect(codeOf(await w.decide(w.ava, approved, 'approve'))).toBe('not-a-refusal');
    expect(codeOf(await w.decide(w.ava, approved, 'refuse'))).toBe(
      'CHANGE_REQUEST_ALREADY_DECIDED',
    );
    expect(await stateOf(approved)).toMatchObject({
      state: 'approved',
      decided_by_person_id: w.ava.personId,
    });

    const refusedOne = await filed();
    const answer = await w.decide(w.ava, refusedOne, 'refuse');
    expect(detailOf(answer)).toStrictEqual({ changeRequestId: refusedOne, state: 'refused' });
    expect(codeOf(await w.decide(w.ava, refusedOne, 'approve'))).toBe(
      'CHANGE_REQUEST_ALREADY_DECIDED',
    );
    expect(await stateOf(refusedOne)).toMatchObject({ state: 'refused', created_task_id: null });
  });

  it('C57 audit readback', async () => {
    const { clientPin } = await w.pins();
    const since = await auditMark();
    const id = detailOf(await w.propose(w.ava, clientPin))['changeRequestId'];
    expect(codeOf(await w.decide(w.ben, id, 'approve'))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await w.decide(w.ava, id, 'approve'))).toBe('not-a-refusal');
    expect(await auditOf(since)).toStrictEqual([
      ['review.propose_change', null],
      ['review.decide_change', 'SCOPE_NOT_GRANTED'],
      ['review.decide_change', null],
    ]);
  });
});
