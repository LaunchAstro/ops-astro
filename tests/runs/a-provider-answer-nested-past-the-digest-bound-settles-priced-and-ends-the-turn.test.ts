// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R3, a provider answer too deep to digest (finding S1900-6). An answer
// whose tool arguments nest 6,000 deep, within both byte limits, reaches the
// broker through real custody from a loopback provider. Its settlement stands
// priced and the attempt ends `cancelled / TURN_MALFORMED`: the answer can never
// be bound by a later turn, and a digest is judged without recursion, so nothing
// throws away the settlement of a call already sent. The first case is the
// proof by Sol (GPT-6.1-Sol), review of #1900 at 790e99dc5b, assertions
// unchanged; the second states what the settlement keeps.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import {
  reserveModelCall,
  sendReservedCall,
  startCustody,
  type Broker,
  type ModelCallRequest,
} from '../../packages/core-custody/src/index.ts';
import { liveWork, rows, type Work } from '../runtime/schedules-harness.ts';
import { s, world, useDoorWorld } from './run-stop-door-world.ts';
import { taskPart, turnBroker, TURN } from './turn-world.ts';

const broker = (): Broker => ({ ...turnBroker(3)(), audit: async () => {} });
const who = (w: Work) => ({
  actorId: s.agentActorId,
  delegationId: String(w.picked['delegationId']),
  attendedByPersonId: null,
});
async function setup(label: string) {
  const work = await liveWork(s, label, 2000);
  const [attempt] = await rows<{ step_id: string }>(
    s,
    'select step_id from public.attempts where business_id=$1 and lease_id=$2',
    [s.business, work.picked['leaseId']],
  );
  const request: ModelCallRequest = {
    leaseId: String(work.picked['leaseId']),
    fence: Number(work.picked['fence']),
    stepId: String(attempt?.step_id),
    operation: TURN,
    fields: [],
    turn: { turnOrdinal: 0, tools: ['task.read'], parts: [await taskPart(work)] },
  };
  const b = broker();
  const reservation = await s.db.app.withBusiness(s.business, (tx) =>
    reserveModelCall(tx, who(work), request, b),
  );
  if (!reservation.ok) throw new Error(`setup ${reservation.code}`);
  return { work, request, b, reserved: reservation.reserved };
}
const ledger = async (id: string) =>
  await rows<Record<string, unknown>>(
    s,
    'select state, actual_minor::int as actual from public.model_calls where business_id=$1 and id=$2',
    [s.business, id],
  );

/** A loopback provider answering once with tool arguments 6,000 deep, behind real custody. */
async function deepProvider() {
  const body =
    '{"text":"Reading.","model":"replay-1","usage":{"input":40,"output":30},"tool_calls":[{"id":"c1","name":"task.read","args":{"taskId":' +
    `${'['.repeat(6000)}0${']'.repeat(6000)}}}]}`;
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const credentialsFile = world.writeCredentials([
    {
      ref: 'replay_key',
      kind: 'api_key',
      account: 'sol-proof-account',
      destination: 'replay',
      header: 'authorization',
      value: 'sol-proof-invented-test-key',
    },
  ]);
  const custody = await startCustody({
    credentialsFile,
    destinations: [{ key: 'replay', origin }],
  });
  const stop = async () => {
    await custody.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  return { body, custody, stop, hits: () => hits };
}

/** What the settlement keeps of a deep answer: the price, no digest, the attempt's end. */
async function settlesPricedAndEndsTheTurn() {
  const { work, request, b, reserved } = await setup('Deep answer settles priced');
  const provider = await deepProvider();
  try {
    const result = await sendReservedCall(s.db.app, s.business, who(work), request, reserved, {
      ...b,
      custody: provider.custody,
    });
    expect(result).toMatchObject({ ok: false, code: 'TURN_MALFORMED', callId: reserved.callId });
    const [call] = await rows<{ state: string; actual: number | null; digest: string | null }>(
      s,
      'select state, actual_minor::int as actual, answer_digest as digest from public.model_calls where business_id=$1 and id=$2',
      [s.business, reserved.callId],
    );
    expect(call?.state).toBe('settled');
    expect(call?.actual).toBeGreaterThan(0);
    expect(call?.digest).toBeNull();
    expect(
      await rows(
        s,
        'select o.outcome, o.end_code from public.run_outcomes o join public.attempts a on a.business_id=o.business_id and a.id=o.attempt_id where a.business_id=$1 and a.lease_id=$2',
        [s.business, request.leaseId],
      ),
    ).toEqual([{ outcome: 'cancelled', end_code: 'TURN_MALFORMED' }]);
  } finally {
    await provider.stop();
  }
}

describe.skipIf(serverUrl === undefined)('a provider answer nested past the digest bound', () => {
  useDoorWorld('deepanswer', turnBroker(3));

  it('a bounded provider JSON answer cannot throw away settlement on nested tool arguments', async () => {
    const { work, request, b, reserved } = await setup('Sol provider numeric argument');
    // Valid JSON below both response and argument byte limits; custody preserves this depth.
    const provider = await deepProvider();
    expect(Buffer.byteLength(provider.body)).toBeLessThan(reserved.operation.maxResponseBytes);
    try {
      const raw: Broker = { ...b, custody: provider.custody };
      const result = await sendReservedCall(
        s.db.app,
        s.business,
        who(work),
        request,
        reserved,
        raw,
      ).then(
        (value) => ({ value }),
        (error) => ({ error: String(error) }),
      );
      expect(provider.hits()).toBe(1);
      const kept = await ledger(reserved.callId);
      const stops = await rows(
        s,
        'select o.end_code from public.run_outcomes o join public.attempts a on a.business_id=o.business_id and a.id=o.attempt_id where a.business_id=$1 and a.lease_id=$2',
        [s.business, request.leaseId],
      );
      expect(result, JSON.stringify({ result, kept, stops })).not.toHaveProperty('error');
      expect(kept[0]?.['state']).not.toBe('dispatched');
    } finally {
      await provider.stop();
    }
  });

  it(
    'the sent call settles priced, the turn is refused TURN_MALFORMED and the attempt ends cancelled',
    settlesPricedAndEndsTheTurn,
  );
});
