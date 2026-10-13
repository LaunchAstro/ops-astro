// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's ChatGPT plan, sent from the owner's machine (#1620). Custody
// there holds the plan's token in its own file, refreshes it when it is due,
// and presents only the access token, to the Responses endpoint only. The
// request that endpoint receives is captured whole: the pinned fields and no
// other. The answer comes back folded to the completed response, with no
// token in it, filed as a subscription. A 429 is the plan's allowance used
// up and a 403 a refusal, by name, each sent once and never again. The fake
// endpoint and token issuer listen on loopback.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHATGPT_PLAN_ASKED_FIELDS,
  CHATGPT_PLAN_TURN,
  chatgptPlanRequest,
} from '../../packages/core-connectors/src/index.ts';
import {
  startCustody,
  type OutboundRequest,
  type ProcessCustody,
} from '../../packages/core-custody/src/agent.ts';
import { agentCustody } from '../../apps/model-agent/main.ts';
import { chatOf } from '../../apps/model-agent/request-check.ts';
import { fake, type Fake } from './plan-fakes.ts';

const SPENT_ACCESS = 'access-spent-xxxxxxxxxxxx';
const SPENT_REFRESH = 'refresh-spent-xxxxxxxxxxxx';
const FRESH_ACCESS = 'access-fresh-xxxxxxxxxxxx';
const FRESH_REFRESH = 'refresh-fresh-xxxxxxxxxxxx';

const completed = {
  id: 'resp_1',
  status: 'completed',
  model: 'gpt-6.1-luna',
  output: [{ type: 'message', content: [{ type: 'output_text', text: `Draft. ${FRESH_ACCESS}` }] }],
  usage: { input_tokens: 10, output_tokens: 3 },
};

const stream = `event: response.completed\ndata: ${JSON.stringify({
  type: 'response.completed',
  response: completed,
})}\n\n`;

/** The expired token file and custody's credential list in `folder`; the list's path. */
function writeFiles(folder: string): string {
  const tokenFile = join(folder, 'chatgpt-plan.json');
  // Expired already: custody refreshes it before the first call.
  writeFileSync(
    tokenFile,
    JSON.stringify({
      clientId: 'app_fake_client',
      accessToken: SPENT_ACCESS,
      refreshToken: SPENT_REFRESH,
      expiresAt: Date.now() - 1000,
    }),
    { mode: 0o600 },
  );
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'ollama_local',
        kind: 'api_key',
        account: 'loopback',
        destination: 'ollama',
        scheme: 'none',
      },
      {
        ref: 'chatgpt_plan',
        kind: 'subscription',
        account: 'owner-plan',
        destination: 'chatgpt_plan',
        scheme: 'oauth_refresh',
        tokenFile,
        refreshDestination: 'chatgpt_sign_in',
      },
    ]),
    { mode: 0o600 },
  );
  return credentialsFile;
}

/** One text delta event of a Responses stream. */
const delta = (text: string): string =>
  `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: 'response.output_text.delta',
    delta: text,
  })}\n\n`;

let folder: string;
let responses: Fake;
let issuer: Fake;
let custody: ProcessCustody;

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'plan-agent-'));
  responses = await fake();
  issuer = await fake();
  issuer.answer = () => ({
    status: 200,
    type: 'application/json',
    body: JSON.stringify({
      access_token: FRESH_ACCESS,
      refresh_token: FRESH_REFRESH,
      expires_in: 3600,
    }),
  });
  responses.answer = () => ({ status: 200, type: 'text/event-stream', body: stream });
  const credentialsFile = writeFiles(folder);
  custody = await startCustody({
    credentialsFile,
    destinations: [
      { key: 'ollama', origin: 'http://127.0.0.1:1' },
      { key: 'chatgpt_plan', origin: responses.origin, stream: 'responses_sse' },
      { key: 'chatgpt_sign_in', origin: issuer.origin, post: false },
    ],
  });
});

afterEach(async () => {
  await custody.stop();
  await responses.close();
  await issuer.close();
  rmSync(folder, { recursive: true, force: true });
});

const settings = { credentialRef: 'ollama_local', chatgptCredentialRef: 'chatgpt_plan' };

function planRequest(body?: string): OutboundRequest {
  const built = chatgptPlanRequest({
    model: 'gpt-6.1-luna',
    instructions: 'Draft the correction.',
    input: [{ role: 'user', content: 'Fix the one word.' }],
    tools: [
      {
        name: 'task_read',
        description: 'Read the task.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  });
  return {
    destination: 'chatgpt_plan',
    path: built.path,
    method: built.method,
    body: body ?? built.body,
    timeoutMs: CHATGPT_PLAN_TURN.timeoutMs,
    maxResponseBytes: CHATGPT_PLAN_TURN.maxResponseBytes,
  };
}

const gate = { deadlineAt: Date.now() + 60_000, onWritten: () => {} };

async function sendOnce(request: OutboundRequest) {
  const checked = chatOf(request);
  expect(checked).toBeDefined();
  return await agentCustody(settings, custody).dispatch(checked as OutboundRequest, gate, () => {});
}

// oxlint-disable-next-line max-lines-per-function -- the plan's cases, each against one fresh custody
describe('the plan goes out from custody on the owner machine', () => {
  it('custody refreshes the spent token, then presents only the fresh access token', async () => {
    const outcome = await sendOnce(planRequest());
    expect(issuer.heard).toHaveLength(1);
    expect(new URLSearchParams(issuer.heard[0]?.body).get('refresh_token')).toBe(SPENT_REFRESH);
    expect(responses.heard).toHaveLength(1);
    expect(responses.heard[0]?.path).toBe('/v1/responses');
    expect(responses.heard[0]?.headers['authorization']).toBe(`Bearer ${FRESH_ACCESS}`);
    expect(outcome.kind).toBe('answered');
  });

  it('the captured request body holds the pinned fields only, store off and streaming on', async () => {
    await sendOnce(planRequest());
    const captured = JSON.parse(responses.heard[0]?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(captured).toSorted()).toEqual([...CHATGPT_PLAN_ASKED_FIELDS].toSorted());
    expect(captured).toMatchObject({ store: false, stream: true });
    expect(captured).not.toHaveProperty('temperature');
  });

  it('the answer is the completed response, filed as a subscription, with no token in it', async () => {
    const outcome = await sendOnce(planRequest());
    if (outcome.kind !== 'answered' || !outcome.outbound.ok) throw new Error('not answered');
    expect(outcome.credentialKind).toBe('subscription');
    const text = JSON.stringify(outcome);
    for (const secret of [SPENT_ACCESS, SPENT_REFRESH, FRESH_ACCESS, FRESH_REFRESH]) {
      expect(text).not.toContain(secret);
    }
    const response = JSON.parse(outcome.outbound.body) as { id: string; status: string };
    expect(response).toMatchObject({ id: 'resp_1', status: 'completed' });
    expect(custody.stderr()).not.toContain(FRESH_ACCESS);
    expect(custody.stderr()).not.toContain(FRESH_REFRESH);
  });

  it('a token split across two delta events is redacted where the response joins it', async () => {
    const [head, rest] = [FRESH_ACCESS.slice(0, 7), FRESH_ACCESS.slice(7)];
    responses.answer = () => ({
      status: 200,
      type: 'text/event-stream',
      body: delta(head) + delta(rest) + stream,
    });
    const outcome = await sendOnce(planRequest());
    expect(JSON.stringify(outcome)).not.toContain(FRESH_ACCESS);
    expect(JSON.stringify(outcome)).not.toContain(rest);
  });

  it('a stream with no completed response is withheld, never passed on', async () => {
    responses.answer = () => ({
      status: 200,
      type: 'text/event-stream',
      body: `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed' } })}\n\n`,
    });
    expect(await sendOnce(planRequest())).toEqual({
      kind: 'withheld',
      started: true,
      reason: 'malformed',
    });
  });

  it.each([
    [429, 'PLAN_ALLOWANCE_WAIT'],
    [403, 'SUBSCRIPTION_REFUSED'],
  ])('a %i is refused by name and sent once only', async (status, code) => {
    responses.answer = () => ({
      status,
      type: 'application/json',
      body: JSON.stringify({ error: { type: 'usage_limit_reached' } }),
    });
    const outcome = await sendOnce(planRequest());
    expect(outcome).toEqual({ kind: 'refused', started: false, code });
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    expect(responses.heard).toHaveLength(1);
  });

  it('a refresh the issuer refuses sends nothing to the Responses endpoint', async () => {
    issuer.answer = () => ({
      status: 400,
      type: 'application/json',
      body: JSON.stringify({ error: 'invalid_grant' }),
    });
    const outcome = await sendOnce(planRequest());
    expect(outcome).toEqual({
      kind: 'refused',
      started: false,
      code: 'SUBSCRIPTION_SIGN_IN_NEEDED',
    });
    expect(responses.heard).toHaveLength(0);
  });
});

describe('the agent checks a plan request before custody sees it', () => {
  const pinned = JSON.parse(planRequest().body) as Record<string, unknown>;
  it.each([
    ['a temperature', { ...pinned, temperature: 0.2 }],
    ['an output cap', { ...pinned, max_output_tokens: 10 }],
    ['an earlier response', { ...pinned, previous_response_id: 'resp_0' }],
    ['store on', { ...pinned, store: true }],
    ['streaming off', { ...pinned, stream: false }],
    ['a model not offered', { ...pinned, model: 'gpt-4o' }],
  ])('a plan request with %s is refused', (_what, body) => {
    expect(chatOf(planRequest(JSON.stringify(body)))).toBeUndefined();
  });

  it('control: the pinned request passes', () => {
    expect(chatOf(planRequest())).toBeDefined();
  });

  it('with no plan credential set, a plan request is refused and custody is asked nothing', async () => {
    const without = agentCustody({ credentialRef: 'ollama_local' }, custody);
    const outcome = await without.dispatch(planRequest(), gate, () => {});
    expect(outcome).toEqual({ kind: 'refused', started: false, code: 'REQUEST_REFUSED' });
    expect(issuer.heard).toHaveLength(0);
    expect(responses.heard).toHaveLength(0);
  });
});
