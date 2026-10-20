// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R3, an answer too deep to digest on the attempt's last place (finding
// S1900-7, criterion 3). The settlement of the limit-th call ends the attempt
// `call_limit / CALL_LIMIT_REACHED` whatever its answer, a deep one included;
// only a deep answer before the limit ends `cancelled / TURN_MALFORMED`. The
// digest binding keeps its scope, and a part too deep to digest is unbound
// before any stored answer is read. Proof by Sol (GPT-6.1-Sol), review of #1900,
// finding S1900-7, assertions unchanged.

import { expect, it } from 'vitest';
import { settledAnswer } from '../../packages/core-custody/src/broker-limit.ts';
import { answerDigest, bindTurn } from '../../packages/core-custody/src/broker-turn.ts';
import { readReplayAnswer } from '../../packages/core-connectors/src/replay-adapter.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';

const nested = (depth: number): unknown => JSON.parse(`${'['.repeat(depth)}0${']'.repeat(depth)}`);
const calls = (depth: number) => [{ id: 'c1', name: 'task.read', args: { taskId: nested(depth) } }];

// Only the database boundary is replaced. Both settlement's decision and the
// real stop writer execute; unexpected SQL fails instead of silently succeeding.
function alreadySettled(atLimit: boolean) {
  let outcome: { outcome: unknown; end_code: unknown } | undefined;
  const tx: TenantQuery = {
    businessId: 'sol-business',
    query<Row>(sql: string, params: readonly unknown[] = []): Promise<readonly Row[]> {
      expect(params[0]).toBe('sol-business');
      let result: unknown[];
      if (sql.includes('select call_ordinal + 1 >= call_limit')) result = [{ reaches: atLimit }];
      else if (sql.includes('set answer_digest')) result = [];
      else if (sql.includes('select delegation_id')) result = [{ delegation_id: null }];
      else if (sql.includes('select a.id, a.run_id'))
        result = [{ id: 'attempt', run_id: 'run', holder: 'agent' }];
      else if (sql.includes('select id, state from public.model_calls')) result = [];
      else if (sql.includes('insert into public.run_outcomes')) {
        outcome = { outcome: params[3], end_code: params[4] };
        result = [];
      } else if (sql.includes('select outcome, end_code'))
        result = outcome === undefined ? [] : [outcome];
      else if (sql.includes('update public.leases')) result = [];
      else throw new Error(`Unexpected SQL: ${sql}`);
      return Promise.resolve(result as Row[]);
    },
  };
  return { tx, outcome: () => outcome };
}

function answer(depth: number) {
  const value = readReplayAnswer(
    JSON.parse(
      JSON.stringify({
        text: 'Reading.',
        model: 'replay-1',
        usage: { input: 40, output: 30 },
        tool_calls: calls(depth),
      }),
    ),
  );
  if (value === undefined) throw new Error('Provider reader rejected the proof fixture');
  return value;
}

it('a 6000-deep provider answer has no digest and cannot throw at the answer boundary', async () => {
  expect(answerDigest('Reading.', calls(6000))).toBeUndefined();
  const kept = alreadySettled(false);
  // JSON.stringify itself is recursive, so read this fixture from wire JSON.
  const value = readReplayAnswer(
    JSON.parse(
      '{"text":"Reading.","model":"replay-1","usage":{"input":40,"output":30},"tool_calls":[{"id":"c1","name":"task.read","args":{"taskId":' +
        '['.repeat(6000) +
        '0' +
        ']'.repeat(6000) +
        '}}]}',
    ),
  );
  if (value === undefined) throw new Error('Provider reader rejected the deep fixture');
  await expect(
    settledAnswer(
      kept.tx,
      'lease',
      { callId: 'call', reservedMinor: 500 },
      { costMinor: 100, answer: value },
      'business_internal',
    ),
  ).resolves.toMatchObject({ ok: false, code: 'TURN_MALFORMED' });
  expect(kept.outcome()).toEqual({ outcome: 'cancelled', end_code: 'TURN_MALFORMED' });
});

it('an accepted 62-deep answer on the limit call still ends call_limit', async () => {
  const kept = alreadySettled(true);
  await settledAnswer(
    kept.tx,
    'lease',
    { callId: 'call', reservedMinor: 500 },
    { costMinor: 100, answer: answer(62) },
    'business_internal',
  );
  expect(kept.outcome()).toEqual({ outcome: 'call_limit', end_code: 'CALL_LIMIT_REACHED' });
});

it('a shallow answer at the limit is the call_limit control', async () => {
  const kept = alreadySettled(true);
  const result = await settledAnswer(
    kept.tx,
    'lease',
    { callId: 'call', reservedMinor: 500 },
    { costMinor: 100, answer: answer(1) },
    'business_internal',
  );
  expect(result).toMatchObject({ ok: true, terminal: 'call_limit' });
  expect(kept.outcome()).toEqual({ outcome: 'call_limit', end_code: 'CALL_LIMIT_REACHED' });
});

it('digest binding keeps business and attempt scope and the stored source', async () => {
  let lookups = 0;
  const tx: TenantQuery = {
    businessId: 'sol-business',
    query<Row>(sql: string, params: readonly unknown[] = []): Promise<readonly Row[]> {
      lookups++;
      expect(sql).toContain('business_id = $1');
      expect(sql).toContain('lease_id = $3');
      expect(sql).toContain("state = 'settled'");
      expect(params).toEqual([
        'sol-business',
        '11111111-1111-4111-8111-111111111111',
        'sol-lease',
        answerDigest('Reading.', []),
      ]);
      return Promise.resolve([{ answer_source: 'outside' }] as Row[]);
    },
  };
  const bound = await bindTurn(
    tx,
    { leaseId: 'sol-lease', source: {} as never },
    {
      ordinal: 1,
      tools: [],
      parts: [
        {
          ref: 'answer',
          callId: '11111111-1111-4111-8111-111111111111',
          text: 'Reading.',
          toolCalls: [],
        },
      ],
    },
  );
  expect(bound?.source).toBe('outside');
  expect(lookups).toBe(1);
});

it('an over-depth answer part is unbound before any stored answer is read', async () => {
  const tx: TenantQuery = {
    businessId: 'sol-business',
    query() {
      return Promise.reject(new Error('An undigestible answer must not query any stored answer'));
    },
  };
  expect(
    await bindTurn(
      tx,
      { leaseId: 'sol-lease', source: {} as never },
      {
        ordinal: 1,
        tools: ['task.read'],
        parts: [
          {
            ref: 'answer',
            callId: '11111111-1111-4111-8111-111111111111',
            text: 'Reading.',
            toolCalls: calls(62),
          },
        ],
      },
    ),
  ).toBeUndefined();
});
