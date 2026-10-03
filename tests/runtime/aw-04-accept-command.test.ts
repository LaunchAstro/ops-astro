// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: the plan accept as a command. `task.accept_plan` is one person's
// click, at parity on the API and the command line: in one transaction it
// validates the structured plan record, approves the plan's gate with the
// origin conversation, binds the exact words and the record by digest, and
// pins the entry file read from the server's own instruction root. A refusal
// writes nothing; a repeat of the operation id replays; a stale version is
// refused.

import { createHash, randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { payloadDigest } from '../../packages/core-digest/src/index.ts';
import { INSTRUCTION_ROOT_VARIABLE } from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { ENTRY, FILES, fingerprint } from './aw-02-world.ts';
import {
  acceptBody,
  conversationOf,
  gateOf,
  noDatabase,
  PLAN,
  PLAN_TEXT,
  pinsOf,
  planRecordsOf,
  proposed,
  useAw04World,
  useInstructionRoot,
  w,
  type Proposed,
} from './aw-04-world.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  freshPurpose,
  propose,
  type Body,
} from './schedules-harness.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw04World('aw04_cmd');
useInstructionRoot();

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Nothing moved on `plan`: the gate pending, no decision, no pin, no bound record. */
async function untouched(plan: Proposed): Promise<void> {
  expect(await gateOf(w.alpha, plan.proposal['gateId'])).toEqual({
    state: 'pending',
    decisions: '0',
  });
  expect(await pinsOf(w.alpha, plan.proposal['runId'])).toEqual([]);
  expect(await planRecordsOf(w.alpha, plan.proposal['gateId'])).toEqual([]);
}

it('AW-04 accept binds the exact words and the structured record, pins the entry file and names the origin conversation, in one click', async () => {
  const plan = await proposed(w.alpha, 'aw04 cmd binds');
  const conversation = await conversationOf(w.alpha, w.alpha.decider);
  const body = acceptBody(plan, { conversationId: conversation });
  const detail = appliedDetail(await asPerson(w.alpha, body), 'task.accept_plan');
  expect(detail['decision']).toBe('approve');
  expect(detail['runId']).toBe(plan.proposal['runId']);
  expect(detail['textDigest']).toBe(sha256(PLAN_TEXT));
  expect(detail['recordDigest']).toBe(payloadDigest(PLAN));
  expect(detail['pin']).toMatchObject({ path: ENTRY, size: FILES.get(ENTRY)?.byteLength });

  const [bound, ...more] = await planRecordsOf(w.alpha, plan.proposal['gateId']);
  expect(more).toEqual([]);
  expect(bound).toMatchObject({
    decision_id: detail['decisionId'],
    run_id: plan.proposal['runId'],
    origin_conversation_id: conversation,
    plan_text: PLAN_TEXT,
    text_digest: sha256(PLAN_TEXT),
    record: PLAN,
    record_digest: payloadDigest(PLAN),
  });
  expect(await pinsOf(w.alpha, plan.proposal['runId'])).toHaveLength(1);
  const audit = await w.alpha.db.admin.execute<{ origin: string | null }>(
    `select origin_conversation_id::text as origin from public.audit_events
      where business_id = $1 and command = 'task.accept_plan' and outcome = 'applied'
        and operation_id = $2`,
    [w.alpha.business, body['operationId']],
  );
  expect(audit.map((row) => row.origin)).toEqual([conversation]);
});

it('AW-04 accept is at parity on the command line', async () => {
  const plan = await proposed(w.alpha, 'aw04 cmd cli');
  const result = await executeCommand(
    w.alpha.db.app,
    w.alpha.business,
    w.alpha.decider.presented,
    'cli',
    acceptBody(plan) as never,
  );
  const detail = appliedDetail(result, 'task.accept_plan');
  expect(detail['runId']).toBe(plan.proposal['runId']);
  expect(await planRecordsOf(w.alpha, plan.proposal['gateId'])).toHaveLength(1);
});

const step = (key: string, after: readonly string[] = []): Body => ({
  key,
  title: `step ${key}`,
  after,
});

it('AW-04 plan validation: an unknown field, a missing or foreign reference, a duplicate or a cycle refuses the accept and writes nothing', async () => {
  const invalid: readonly [string, unknown][] = [
    ['unknown top field', { ...PLAN, owner: 'someone' }],
    ['unknown step field', { steps: [{ ...step('a'), kind: 'anything' }] }],
    ['no steps', { steps: [] }],
    ['not a record', ['draft']],
    ['missing reference', { steps: [step('a'), step('b', ['nope'])] }],
    ['foreign reference', { steps: [step('a', [randomUUID()])] }],
    ['duplicate key', { steps: [step('a'), step('a')] }],
    ['duplicate reference', { steps: [step('a'), step('b', ['a', 'a'])] }],
    ['self cycle', { steps: [step('a', ['a'])] }],
    ['cycle', { steps: [step('a', ['c']), step('b', ['a']), step('c', ['b'])] }],
    ['odd key', { steps: [step('A B')] }],
    ['empty title', { steps: [{ key: 'a', title: ' ', after: [] }] }],
  ];
  const plan = await proposed(w.alpha, 'aw04 cmd invalid');
  for (const [label, record] of invalid) {
    // eslint-disable-next-line no-await-in-loop
    const result = await asPerson(w.alpha, acceptBody(plan, { plan: record }));
    expect(codeOf(result), label).toBe('FIELD_VALUE_INVALID');
    expect(JSON.stringify(result), label).toContain('plan');
  }
  for (const text of ['', ' ', 'x'.repeat(20_001)]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await asPerson(w.alpha, acceptBody(plan, { planText: text }));
    expect(codeOf(result)).toBe('FIELD_VALUE_INVALID');
  }
  await untouched(plan);
  // Control: the same gate accepts the valid plan.
  appliedDetail(await asPerson(w.alpha, acceptBody(plan)), 'task.accept_plan');
});

it('AW-04 authority: an agent cannot accept, a person without decide cannot, and an odd path or another person conversation is refused before any write', async () => {
  const plan = await proposed(w.alpha, 'aw04 cmd authority');
  const agent = await asAgent(w.alpha, acceptBody(plan));
  expect(codeOf(agent)).toBe('DELEGATION_EXCLUDES_OPERATION');
  const reader = await enrol(w.alpha.db.app, w.alpha.business, `aw04-reader-${randomUUID()}`);
  await w.alpha.db.app.withBusiness(w.alpha.business, async (tx) => {
    await grantTo(tx, reader, 'read');
  });
  const withoutDecide = await executeCommand(
    w.alpha.db.app,
    w.alpha.business,
    reader.presented,
    'api',
    acceptBody(plan) as never,
  );
  expect(codeOf(withoutDecide)).toBe('SCOPE_NOT_GRANTED');
  for (const entryPath of ['../SKILL.md', '/etc/passwd', 'skills/./brief/SKILL.md', '']) {
    // eslint-disable-next-line no-await-in-loop
    const odd = await asPerson(w.alpha, acceptBody(plan, { entryPath }));
    expect(codeOf(odd), entryPath).toBe('DEFINITION_UNAVAILABLE');
  }
  const theirs = await conversationOf(w.alpha, reader);
  const foreignConversation = await asPerson(w.alpha, acceptBody(plan, { conversationId: theirs }));
  expect(codeOf(foreignConversation)).toBe('NOT_FOUND');
  expect(JSON.stringify(foreignConversation)).not.toContain(theirs);
  await untouched(plan);
});

it('AW-04 replay: the same operation id and payload replays the committed accept; a changed payload is OPERATION_ID_REUSED', async () => {
  const plan = await proposed(w.alpha, 'aw04 cmd replay');
  const body = acceptBody(plan);
  const first = appliedDetail(await asPerson(w.alpha, body), 'task.accept_plan');
  const again = appliedDetail(await asPerson(w.alpha, body), 'task.accept_plan');
  expect(again).toEqual(first);
  const changed = await asPerson(w.alpha, { ...body, planText: `${PLAN_TEXT} And more.` });
  expect(codeOf(changed)).toBe('OPERATION_ID_REUSED');
  expect(await gateOf(w.alpha, plan.proposal['gateId'])).toEqual({
    state: 'approved',
    decisions: '1',
  });
  expect(await planRecordsOf(w.alpha, plan.proposal['gateId'])).toHaveLength(1);
  expect(await pinsOf(w.alpha, plan.proposal['runId'])).toHaveLength(1);
});

it('accept_carries_displayed_version: an accept of a version a newer reply replaced is refused and binds nothing', async () => {
  const plan = await proposed(w.alpha, 'aw04 cmd stale');
  const newer = await propose(w.alpha, plan.taskId, {
    maximumMinor: 1_000,
    purpose: freshPurpose(),
    lineageId: String(plan.proposal['lineageId']),
  });
  const stale = await asPerson(w.alpha, acceptBody(plan));
  expect(codeOf(stale)).toBe('PROPOSAL_SUPERSEDED');
  expect(await planRecordsOf(w.alpha, plan.proposal['gateId'])).toEqual([]);
  expect(await planRecordsOf(w.alpha, newer['gateId'])).toEqual([]);
  // Control: the version on screen now is accepted.
  appliedDetail(
    await asPerson(w.alpha, acceptBody({ taskId: plan.taskId, proposal: newer })),
    'task.accept_plan',
  );
  expect(await planRecordsOf(w.alpha, newer['gateId'])).toHaveLength(1);
});

it('AW-04 bound plan refuses edits: the application may neither change nor remove the bound words or record', async () => {
  const plan = await proposed(w.alpha, 'aw04 cmd immutable');
  appliedDetail(await asPerson(w.alpha, acceptBody(plan)), 'task.accept_plan');
  for (const statement of [
    `update public.plan_records set plan_text = 'changed' where gate_id = $1`,
    `update public.plan_records set record = '{}'::jsonb where gate_id = $1`,
    `delete from public.plan_records where gate_id = $1`,
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const attempt = w.alpha.db.app.withBusiness(w.alpha.business, async (tx) => {
      await tx.query(statement, [plan.proposal['gateId']]);
    });
    // eslint-disable-next-line no-await-in-loop
    await expect(attempt).rejects.toThrow(/permission denied/u);
  }
  const [bound] = await planRecordsOf(w.alpha, plan.proposal['gateId']);
  expect(bound?.plan_text).toBe(PLAN_TEXT);
});

it('AW-04 accept with no instruction root configured is refused and writes nothing', async () => {
  const plan = await proposed(w.alpha, 'aw04 cmd no root');
  const before = await fingerprint(w.alpha);
  const root = process.env[INSTRUCTION_ROOT_VARIABLE];
  delete process.env[INSTRUCTION_ROOT_VARIABLE];
  try {
    const result = await asPerson(w.alpha, acceptBody(plan));
    expect(codeOf(result)).toBe('DEPENDENCY_NOT_LANDED');
  } finally {
    process.env[INSTRUCTION_ROOT_VARIABLE] = root;
  }
  expect(await fingerprint(w.alpha)).toBe(before);
  await untouched(plan);
});

it('AW-04 canary: the plan words never ride out in a refusal', async () => {
  const plan = await proposed(w.alpha, 'aw04 cmd canary');
  const canary = `aw04-words-${randomUUID()}`;
  const refusals = [
    await asPerson(w.alpha, acceptBody(plan, { planText: canary, plan: { steps: [] } })),
    await asPerson(w.alpha, acceptBody(plan, { planText: canary, entryPath: '../x' })),
    await asAgent(w.alpha, acceptBody(plan, { planText: canary })),
  ];
  for (const result of refusals) {
    expect(codeOf(result)).not.toBe('applied');
    expect(JSON.stringify(result)).not.toContain(canary);
  }
  await untouched(plan);
});
