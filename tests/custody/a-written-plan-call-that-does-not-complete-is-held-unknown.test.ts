// SPDX-License-Identifier: AGPL-3.0-only
//
// Once a plan call's request is written, the plan may have run it, so only a
// complete, well-formed answer settles it (#1926, S1916-3 on #1916). Through
// the real custody process and a loopback endpoint, every other ending is
// held as unknown and never released as nothing happened: a refusal the plan
// names, a body cut short, a connection dropped, a timeout, a malformed error
// page and a usage limit inside the stream. Each would have been a named
// refusal, `started: false`. The first case is Sol's proof, its assertions
// unchanged.

import type { ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import {
  CHATGPT_PLAN_CONVERSATION,
  chatgptPlanAdapter,
  registerModelOperation,
} from '../../packages/core-connectors/src/index.ts';
import { settlementOf } from '../../packages/core-custody/src/broker-settle.ts';
import type { ProviderAdapter } from '../../packages/core-custody/src/broker-types.ts';
import type { CustodyOutcome } from '../../packages/core-custody/src/custody.ts';
import { open } from './fixtures/plan-inflight-world.ts';
import { completed } from './fixtures/plan-answer-world.ts';
import { planRequest } from './fixtures/plan-route-world.ts';

const ADAPTER: ProviderAdapter = {
  build: (values, operationId, model) => chatgptPlanAdapter(values, operationId, model),
  price: () => 0,
};
const registered = registerModelOperation(CHATGPT_PLAN_CONVERSATION);
if (!registered.ok) throw new Error('the plan operation does not register');
const OPERATION = registered.operation;

/** One plan call whose endpoint answers as `answer` does; whether it was written, and its outcome. */
async function written(answer: (response: ServerResponse) => void, timeoutMs = 1000) {
  const w = await open();
  try {
    w.onRequest(answer);
    let wrote = false;
    const result = await w.custody.dispatchBefore(
      'chatgpt_plan',
      { ...planRequest(), timeoutMs },
      {
        deadlineAt: Date.now() + 3000,
        onWritten: () => {
          wrote = true;
        },
      },
    );
    await w.arrived;
    return { wrote, result };
  } finally {
    await w.close();
  }
}

const settled = (result: CustodyOutcome) => settlementOf(result, OPERATION, ADAPTER, true).kind;

it('an interrupted error response is still an unknown written send', async () => {
  const w = await open();
  try {
    w.onRequest((res) => {
      res.writeHead(503, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{');
      // No complete response arrives.
      setTimeout(() => res.destroy(), 30);
    });
    let wasWritten = false;
    const result = await w.custody.dispatchBefore(
      'chatgpt_plan',
      { ...planRequest(), timeoutMs: 1000 },
      {
        deadlineAt: Date.now() + 3000,
        onWritten: () => {
          wasWritten = true;
        },
      },
    );
    await w.arrived;
    expect(wasWritten).toBe(true);
    expect(result).not.toMatchObject({ kind: 'refused', started: false });
    expect(result).toMatchObject({
      kind: 'answered',
      started: true,
      outbound: { ok: false, fault: 'network', status: 503 },
    });
  } finally {
    await w.close();
  }
}, 15000);

const usageLimitStream = (): string => {
  const failed = {
    ...completed(['par']),
    status: 'failed',
    error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' },
  };
  const events = [
    { type: 'response.output_text.delta', delta: 'par' },
    { type: 'response.failed', response: failed },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
};

it.each([
  [
    'a refusal the plan names, whole (403)',
    (res: ServerResponse) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no' } }));
    },
  ],
  [
    'a body cut short (400)',
    (res: ServerResponse) => {
      res.writeHead(400, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"error":');
      setTimeout(() => res.destroy(), 30);
    },
  ],
  [
    'a connection dropped after its status (401)',
    (res: ServerResponse) => {
      res.writeHead(401, { 'content-type': 'application/json', 'content-length': '1000' });
      res.flushHeaders();
      setTimeout(() => res.destroy(), 30);
    },
  ],
  [
    'a timeout after its status (429)',
    (res: ServerResponse) => {
      res.writeHead(429, { 'content-type': 'application/json', 'content-length': '1000' });
      res.flushHeaders();
    },
  ],
  [
    'a malformed error page (503)',
    (res: ServerResponse) => {
      res.writeHead(503, { 'content-type': 'text/html' });
      res.end('<html><body>upstream');
    },
  ],
  [
    'a usage limit inside the stream',
    (res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(usageLimitStream());
    },
  ],
])(
  'a written plan call that ends in %s is held as unknown, never released',
  async (_, answer) => {
    const { wrote, result } = await written(answer, 300);
    expect(wrote).toBe(true);
    expect(result.kind).not.toBe('refused');
    expect(result.started).toBe(true);
    expect(settled(result)).toBe('unknown');
  },
  15_000,
);
