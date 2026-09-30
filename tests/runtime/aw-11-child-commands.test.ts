// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11: the hand-over and the handback as agent operations. The parent's
// agent asks `run.delegate_child` on its own lease with the credential its
// pickup gave it, and `authorise` resolves the parent from that credential,
// never from the body; the helper hands back with its own child credential,
// which the runtime binds to the helper's own login. Replay derives the
// child's credential again rather than reading it from the register. A person
// reaches neither.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { revokeDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { appliedDetail, codeOf as callOf, rows, type Schedules } from './schedules-harness.ts';
import {
  callCode,
  noDatabase,
  parentWork,
  readAsHelper,
  useChildWorld,
  w,
} from './aw-11-child-world.ts';
import { resultsOf } from './aw-11-child-work-world.ts';
import {
  asPersonCall,
  delegateBody,
  delegateCall,
  handbackBody,
  handbackCall,
} from './aw-11-child-commands-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw11c');

async function childCount(on: Schedules, parentId: string): Promise<number> {
  const found = await rows<{ n: string }>(
    on,
    `select count(*)::text as n from public.delegations
      where business_id = $1 and parent_delegation_id = $2`,
    [on.business, parentId],
  );
  return Number(found[0]?.n);
}

/** Parent work, and the helper handed `task:read` on it through the command. */
async function handedOver() {
  const mine = await parentWork(w.s);
  const body = delegateBody(mine.work, w.helper);
  const answer = appliedDetail(await delegateCall(w.s, mine.credential, body), 'the hand-over');
  return {
    ...mine,
    body,
    answer,
    childId: String(answer['childDelegationId']),
    childCredential: String(answer['credential']),
  };
}

it('AW-11 run.delegate_child hands the helper its one-call pickup through the agent entry', async () => {
  const { work, parent, answer, childCredential } = await handedOver();
  expect(answer).toMatchObject({
    businessId: w.s.business,
    resource: {
      taskId: work.taskId,
      runId: work.picked['runId'],
      leaseId: work.picked['leaseId'],
      fence: work.picked['fence'],
    },
    permittedOperations: ['task:read'],
    actorScope: { agentActorId: w.helper.actorId },
  });
  expect(childCredential).toMatch(/.{20,}/u);
  expect(await childCount(w.s, parent.id)).toBe(1);
  // The helper, signed in as itself, reads the parent's task on it.
  expect(callCode(await readAsHelper(w.s, w.helper, childCredential, work.taskId))).toBe('applied');
  // The register keeps no credential: the stored answer holds none.
  const stored = await rows<{ detail: string }>(
    w.s,
    `select result::text as detail from public.operations
      where business_id = $1 and result::text like $2`,
    [w.s.business, `%${String(answer['childDelegationId'])}%`],
  );
  expect(stored.length).toBeGreaterThan(0);
  for (const row of stored) expect(row.detail).not.toContain(childCredential);
});

it("AW-11 the hand-over's parent is the caller's own credential, never the body", async () => {
  const mine = await parentWork(w.s);
  const other = await parentWork(w.s);
  // My credential naming another pickup's lease: outside my delegation's purpose.
  const crossed = await delegateCall(w.s, mine.credential, delegateBody(other.work, w.helper));
  expect(callOf(crossed)).toBe('DELEGATION_OUT_OF_PURPOSE');
  // No credential at all: an agent login before any pickup reaches none of it.
  const bare = await delegateCall(w.s, undefined, delegateBody(mine.work, w.helper));
  expect(callOf(bare)).toBe('DELEGATION_EXCLUDES_OPERATION');
  // A task-only parent, on its own lease, holds no `run:write` to hand over with.
  const narrow = await delegateCall(
    w.s,
    w.taskOnlyCredential,
    delegateBody(w.taskOnlyWork, w.helper),
  );
  expect(callOf(narrow)).toBe('DELEGATION_OUT_OF_PURPOSE');
  for (const parent of [mine.parent, other.parent, w.taskOnly]) {
    // One call at a time: each refusal is read on its own, nothing written between.
    // oxlint-disable-next-line no-await-in-loop
    expect(await childCount(w.s, parent.id)).toBe(0);
  }
});

it('AW-11 the hand-over body is checked before anything is written', async () => {
  const mine = await parentWork(w.s);
  const bad: readonly [Record<string, unknown>, string][] = [
    [{ helperActorId: 7 }, 'FIELD_VALUE_INVALID'],
    [{ helperActorId: 'not-a-uuid' }, 'FIELD_VALUE_INVALID'],
    [{ purpose: '' }, 'FIELD_VALUE_INVALID'],
    [{ purpose: ['helper'] }, 'FIELD_VALUE_INVALID'],
    [{ collections: 'task' }, 'FIELD_VALUE_INVALID'],
    [{ collections: [] }, 'FIELD_VALUE_INVALID'],
    [{ collections: ['task', 7] }, 'FIELD_VALUE_INVALID'],
    [{ actions: ['fly'] }, 'FIELD_VALUE_INVALID'],
    [{ actions: 'read' }, 'FIELD_VALUE_INVALID'],
    [{ expiresInSeconds: -1 }, 'FIELD_VALUE_INVALID'],
    [{ expiresInSeconds: '600' }, 'FIELD_VALUE_INVALID'],
    [{ expiresInSeconds: 1.5 }, 'FIELD_VALUE_INVALID'],
    [{ fence: '1' }, 'FIELD_VALUE_INVALID'],
    [{ child: { agentActorId: w.helper.actorId } }, 'COMMAND_BODY_INVALID'],
    // A person's actor and a made-up one: one answer, and neither reaches the mint.
    [{ helperActorId: w.s.decider.actorId }, 'FIELD_VALUE_INVALID'],
    [{ helperActorId: randomUUID() }, 'FIELD_VALUE_INVALID'],
  ];
  for (const [extra, code] of bad) {
    // One call at a time: each refusal is read on its own, nothing written between.
    // oxlint-disable-next-line no-await-in-loop
    const answer = await delegateCall(
      w.s,
      mine.credential,
      delegateBody(mine.work, w.helper, extra),
    );
    expect({ extra, code: callOf(answer) }).toEqual({ extra, code });
  }
  expect(await childCount(w.s, mine.parent.id)).toBe(0);
});

it('AW-11 the child is strictly narrower through the command, and never decides', async () => {
  const mine = await parentWork(w.s);
  const wider = await delegateCall(
    w.s,
    mine.credential,
    delegateBody(mine.work, w.helper, { collections: ['task', 'billing'] }),
  );
  expect(callOf(wider)).toBe('DELEGATION_WIDENS');
  const deciding = await delegateCall(
    w.s,
    mine.credential,
    delegateBody(mine.work, w.helper, { actions: ['read', 'decide'] }),
  );
  expect(callOf(deciding)).toBe('DELEGATION_EXCLUDES_DECISION');
  expect(await childCount(w.s, mine.parent.id)).toBe(0);
});

it("AW-11 the hand-over's replay derives the same credential and mints no second child", async () => {
  const first = await handedOver();
  const again = appliedDetail(
    await delegateCall(w.s, first.credential, first.body),
    'the hand-over replayed',
  );
  expect(again['childDelegationId']).toBe(first.childId);
  expect(again['credential']).toBe(first.childCredential);
  expect(await childCount(w.s, first.parent.id)).toBe(1);
  // The same operation id with another body is not a replay.
  const changed = await delegateCall(w.s, first.credential, {
    ...first.body,
    expiresInSeconds: 300,
  });
  expect(callOf(changed)).toBe('OPERATION_ID_REUSED');
  // Once the helper has handed back, the child is settled: nothing is re-released.
  expect(callOf(await handbackCall(w.s, w.helper, first.childCredential, handbackBody()))).toBe(
    'applied',
  );
  const late = await delegateCall(w.s, first.credential, first.body);
  expect(callOf(late)).toBe('DELEGATION_NOT_LIVE');
  expect(JSON.stringify(late)).not.toContain(first.childCredential);
});

it("AW-11 run.child_handback lands the helper's result on the parent's run", async () => {
  const done = await handedOver();
  expect(callOf(await handbackCall(w.s, w.helper, done.childCredential, handbackBody()))).toBe(
    'applied',
  );
  expect(await resultsOf(w.s, done.parent)).toMatchObject([
    { childDelegationId: done.childId, state: 'handed_back', outcome: 'completed' },
  ]);
  // Revoked mid-child: the partial work comes back naming the refusal.
  const cut = await handedOver();
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await revokeDelegation(tx, cut.childId);
  });
  const partial = handbackBody({ outcome: 'partial', refusal: 'DELEGATION_REVOKED' });
  expect(callOf(await handbackCall(w.s, w.helper, cut.childCredential, partial))).toBe('applied');
  expect(await resultsOf(w.s, cut.parent)).toMatchObject([
    { state: 'handed_back', outcome: 'partial', refusal: 'DELEGATION_REVOKED' },
  ]);
});

it('AW-11 the handback body names completed work, or partial work with its refusal', async () => {
  const mine = await handedOver();
  for (const extra of [
    { outcome: 'partial' },
    { outcome: 'partial', refusal: 'NOT_A_CODE' },
    { outcome: 'done' },
    { outcome: ['completed'] },
  ]) {
    // One call at a time: each refusal is read on its own, nothing written between.
    // oxlint-disable-next-line no-await-in-loop
    const answer = await handbackCall(w.s, w.helper, mine.childCredential, handbackBody(extra));
    expect({ extra, code: callOf(answer) }).toEqual({ extra, code: 'COMMAND_BODY_INVALID' });
  }
  const stray = await handbackCall(
    w.s,
    w.helper,
    mine.childCredential,
    handbackBody({ leaseId: mine.work.picked['leaseId'] }),
  );
  expect(callOf(stray)).toBe('COMMAND_BODY_INVALID');
  expect(await resultsOf(w.s, mine.parent)).toMatchObject([{ state: 'working' }]);
});

it("AW-11 the handback is the helper's own credential, once, and replays only to it", async () => {
  const mine = await handedOver();
  const bare = await handbackCall(w.s, w.helper, undefined, handbackBody());
  expect(callOf(bare)).toBe('DELEGATION_EXCLUDES_OPERATION');
  // The parent's agent with either credential is no helper.
  const asParent = await delegateCall(w.s, mine.credential, handbackBody());
  const borrowed = await delegateCall(w.s, mine.childCredential, handbackBody());
  expect(callOf(asParent)).toBe('DELEGATION_NOT_LIVE');
  expect(callOf(borrowed)).toBe('DELEGATION_NOT_LIVE');
  const body = handbackBody();
  const first = await handbackCall(w.s, w.helper, mine.childCredential, body);
  expect(callOf(first)).toBe('applied');
  // Its replay, to the same helper and credential, is the same answer.
  const replay = await handbackCall(w.s, w.helper, mine.childCredential, body);
  expect(replay).toEqual(first);
  // Without the credential the replay releases nothing.
  const bareReplay = await handbackCall(w.s, w.helper, undefined, body);
  expect(callOf(bareReplay)).toBe('DELEGATION_EXCLUDES_OPERATION');
  // A second handback, a new operation, is refused: the child is settled.
  const second = await handbackCall(w.s, w.helper, mine.childCredential, handbackBody());
  expect(callOf(second)).toBe('DELEGATION_NOT_LIVE');
});

it('AW-11 a person reaches neither the hand-over nor the handback', async () => {
  const mine = await parentWork(w.s);
  const handOver = await asPersonCall(w.s, delegateBody(mine.work, w.helper));
  const handBack = await asPersonCall(w.s, {
    ...handbackBody(),
    operationId: randomUUID(),
  });
  expect(callOf(handOver)).toBe('SCOPE_NOT_GRANTED');
  expect(callOf(handBack)).toBe('SCOPE_NOT_GRANTED');
  expect(await childCount(w.s, mine.parent.id)).toBe(0);
});
