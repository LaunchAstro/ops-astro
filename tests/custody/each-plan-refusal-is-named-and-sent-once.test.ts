// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P3: each refusal the plan answers is a named result, after exactly
// one request and no retry. A loopback stand-in for the Responses endpoint
// counts what reaches it and answers a status with the error body OpenAI
// documents; egress's own reader (`answerOf`) reads it. The error body is
// never read into the result, so a secret planted in it goes nowhere.

import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { answerOf, type Outbound } from '../../packages/core-custody/src/egress-answer.ts';
import { askPlanOnce, type PlanAnswerLog } from '../../packages/core-custody/src/plan-answer.ts';
import { ACCESS, SECRETS, completed, runsIn, sse } from './fixtures/plan-answer-world.ts';

interface Reply {
  readonly status: number;
  readonly type: string;
  readonly body: string;
}

let server: Server;
let reply: Reply;
let seen = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen += 1;
    req.resume();
    res.writeHead(reply.status, { 'content-type': reply.type });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
});
afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    }),
);

/** One POST to the stand-in, read as egress reads an answer. */
const send = (): Promise<Outbound> =>
  new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const req = request(
      { host: '127.0.0.1', port, path: '/v1/responses', method: 'POST' },
      (res) => {
        void answerOf(res, 1_000_000, (status) => ({ ok: false, fault: 'network', status })).then(
          resolve,
          reject,
        );
      },
    );
    req.on('error', reject);
    req.end('{}');
  });

const error = (status: number, code: string): Reply => ({
  status,
  type: 'application/json',
  body: JSON.stringify({ error: { code, message: `echo ${ACCESS}` }, detail: ACCESS }),
});

async function asked(
  answer: Reply,
): Promise<{ readonly result: unknown; readonly log: readonly PlanAnswerLog[] }> {
  reply = answer;
  seen = 0;
  const log: PlanAnswerLog[] = [];
  const result = await askPlanOnce(
    send,
    () => SECRETS,
    (kind) => log.push(kind),
  );
  // Long enough for any retry to have reached the stand-in.
  await new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
  expect(seen).toBe(1);
  expect(runsIn(JSON.stringify({ result, log }))).toEqual([]);
  return { result, log };
}

const named = (code: string) => ({ ok: false, code, words: expect.stringMatching(/\S/u) });

it('maps a 429 usage limit to the plan allowance', async () => {
  const { result, log } = await asked(error(429, 'subscription_sharing_usage_limit_exceeded'));
  expect(result).toEqual(named('SUBSCRIPTION_PLAN_ALLOWANCE'));
  expect(log).toEqual(['plan refused: usage allowance']);
});

it('maps a usage limit that arrives mid-stream to the plan allowance', async () => {
  const failed = {
    ...completed(['par']),
    status: 'failed',
    error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' },
  };
  const body = sse([
    { type: 'response.output_text.delta', delta: 'par' },
    { type: 'response.failed', response: failed },
  ]);
  const { result } = await asked({ status: 200, type: 'text/event-stream', body });
  expect(result).toEqual(named('SUBSCRIPTION_PLAN_ALLOWANCE'));
});

it('maps a 403 to the plan refusing this account', async () => {
  const { result, log } = await asked(error(403, 'subscription_sharing_user_not_eligible'));
  expect(result).toEqual(named('SUBSCRIPTION_NOT_ELIGIBLE'));
  expect(log).toEqual(['plan refused: not eligible']);
});

it('maps a 400 to an unsupported capability', async () => {
  const { result, log } = await asked(error(400, 'subscription_sharing_unsupported_capability'));
  expect(result).toEqual(named('SUBSCRIPTION_UNSUPPORTED_CAPABILITY'));
  expect(log).toEqual(['plan refused: unsupported capability']);
});

it('maps a 401 to signing in again', async () => {
  const { result, log } = await asked(error(401, 'subscription_sharing_invalid_user'));
  expect(result).toEqual(named('SUBSCRIPTION_SIGN_IN_NEEDED'));
  expect(log).toEqual(['plan refused: sign in again']);
});

it('maps both 503 codes to the plan being unavailable, with no retry', async () => {
  const usage = await asked(error(503, 'subscription_sharing_usage_unavailable'));
  const user = await asked(error(503, 'subscription_sharing_user_unavailable'));
  for (const { result, log } of [usage, user]) {
    expect(result).toEqual(named('SUBSCRIPTION_PLAN_UNAVAILABLE'));
    expect(log).toEqual(['plan refused: unavailable']);
  }
});

it('answers a completed stream after the same one request', async () => {
  const body = sse([{ type: 'response.completed', response: completed(['fine']) }]);
  const { result } = await asked({ status: 200, type: 'text/event-stream', body });
  expect(result).toMatchObject({ ok: true });
});
