// SPDX-License-Identifier: AGPL-3.0-only
//
// GPT streamed (LA-1's runner): the app-server's messages are read as a closed
// grammar. Only the agent's message is ever a piece: neither its reasoning nor
// the user's own message echoed back is. A tool item, a request the server
// makes of the runner (an approval, a tool call, a token refresh) or a message
// this grammar does not know stops the call, which is then unknown: charged,
// never answered. A second agent message stops the pieces; the answer is the
// last message, as `codex exec` gives it.

import { describe, expect, it } from 'vitest';
import { answerOf, ndjson, runnerWorld } from './runner-world.ts';
import type { World } from './world.ts';

const { start, call } = runnerWorld();
const PROMPT = 'Say hello.';
/** What a call with this prompt is charged before codex runs: 50,000 and its 10 bytes. */
const NEED = 50_010;

/** One streamed call on a turn played as `knobs` says: its pieces, its answer, the world after. */
async function run(knobs: Record<string, unknown>): Promise<{
  w: World;
  pieces: string[];
  answer: Record<string, unknown> | undefined;
}> {
  const { w, r } = await start();
  w.knobs(knobs);
  const reply = await call(r, { fields: { message: PROMPT }, stream: true });
  const pieces = ndjson(reply.raw).flatMap((line) => {
    const piece = (line as { piece?: unknown }).piece;
    return typeof piece === 'string' ? [piece] : [];
  });
  return { w, pieces, answer: answerOf(reply.raw) };
}

const reasoning = [
  ['item/started', { startedAtMs: 0, item: { id: 'r-1', type: 'reasoning' } }],
  ['item/reasoning/textDelta', { itemId: 'r-1', delta: 'PRIVATE-THOUGHT', contentIndex: 0 }],
  ['item/reasoning/summaryTextDelta', { itemId: 'r-1', delta: 'PRIVATE-SUMMARY', summaryIndex: 0 }],
  ['item/completed', { item: { id: 'r-1', type: 'reasoning' } }],
];

describe("the model's reasoning and the user's own message", () => {
  it('reach no piece, and the answer is still given', async () => {
    const { pieces, answer } = await run({ before: reasoning });
    expect(pieces).toEqual(['Two tasks', ' are due.']);
    expect(pieces.join('')).not.toContain('PRIVATE');
    expect(answer).toMatchObject({ text: 'Two tasks are due.', code: null });
  });
});

describe('a call the grammar stops', () => {
  it.each([
    ['a command', { id: 'c-1', type: 'commandExecution', command: 'ls', status: 'inProgress' }],
    ['a web search', { id: 'w-1', type: 'webSearch', query: 'board' }],
    ['a file change', { id: 'f-1', type: 'fileChange', changes: [], status: 'inProgress' }],
  ])('is unknown when the model reaches for %s: no piece, no answer, charged', async (_l, item) => {
    const { w, pieces, answer } = await run({
      before: [['item/started', { startedAtMs: 0, item }]],
    });
    expect(answer).toMatchObject({ text: '', code: 'LOCAL_GPT_FAILED' });
    expect(pieces).toEqual([]);
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: NEED });
  });

  it.each([
    'item/commandExecution/requestApproval',
    'item/tool/call',
    'account/chatgptAuthTokens/refresh',
  ])('is unknown when the server asks %s, refuses it, and gives no later piece', async (method) => {
    const { w, pieces, answer } = await run({ serverRequest: method });
    expect(answer).toMatchObject({ text: '', code: 'LOCAL_GPT_FAILED' });
    expect(pieces).toEqual(['Two tasks']);
    const refused = w
      .appCalls()
      .map((entry) => entry['message'] as Record<string, unknown> | undefined)
      .find((sent) => sent?.['id'] === 'srv-1');
    expect(refused).toMatchObject({ id: 'srv-1', error: { code: -32601 } });
  });

  it.each([
    ['a message the grammar does not know', { before: [['thread/somethingNew', {}]] }],
    ['output that is not JSON-RPC lines', { raw: 'not json\n' }],
    ['a turn that reports no tokens', { noUsage: true }],
  ])('is unknown on %s, and charged', async (_label, knobs) => {
    const { w, answer } = await run(knobs);
    expect(answer).toMatchObject({ text: '', code: 'LOCAL_GPT_FAILED' });
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: NEED });
  });
});

describe('a turn that ends without its answer', () => {
  it('stops the pieces at a second agent message and answers with the last one', async () => {
    const { pieces, answer } = await run({ second: ['Actually', ' three.'] });
    expect(pieces).toEqual(['Two tasks', ' are due.']);
    expect(answer).toMatchObject({ text: 'Actually three.', code: null });
  });

  it('is failed, with its tokens recorded, when the turn fails', async () => {
    const { w, answer } = await run({ turnError: { message: 'failed', codexErrorInfo: 'other' } });
    expect(answer).toMatchObject({ text: '', code: 'LOCAL_GPT_FAILED' });
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: 120, outputTokens: 7 });
  });

  it('is the plan at its limit, having used nothing, when only the user message was echoed', async () => {
    const { w, answer } = await run({
      deltas: null,
      noUsage: true,
      turnError: { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' },
    });
    expect(answer).toMatchObject({ text: '', code: 'LOCAL_PLAN_LIMIT' });
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it.each([
    ['answers through an error the server will retry', true, { code: null }],
    ['fails on one it will not', false, { text: '', code: 'LOCAL_GPT_FAILED' }],
  ])('%s', async (_label, willRetry, expected) => {
    const { answer } = await run({
      before: [['error', { willRetry, error: { message: 'stream dropped' } }]],
    });
    expect(answer).toMatchObject(expected);
  });
});
