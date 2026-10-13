// SPDX-License-Identifier: AGPL-3.0-only
//
// GPT streamed (LA-1's runner): the app-server's messages are read as a closed
// grammar. Only the agent's message is ever a piece: its reasoning never is. A
// tool item, a request the server makes of the runner (an approval, a tool
// call, a token refresh) or a message this grammar does not know stops the
// call, which is then unknown, never an answer. A second agent message stops
// the pieces; the answer is the last message, as `codex exec` gives it.

import { afterEach, describe, expect, it } from 'vitest';
import { runCodexApp } from '../../apps/local-agent/codex-app.ts';
import { UNKNOWN } from '../../apps/local-agent/codex.ts';
import { readSettings, type RunnerSettings } from '../../apps/local-agent/settings.ts';
import { makeWorld, type World } from './world.ts';

const MODEL = 'gpt-6.1-sol';

let world: World | undefined;
afterEach(() => {
  world?.remove();
  world = undefined;
});

async function run(knobs: Record<string, unknown>): Promise<{
  w: World;
  pieces: string[];
  result: Awaited<ReturnType<typeof runCodexApp>>;
}> {
  const w = makeWorld();
  world = w;
  w.knobs(knobs);
  const read = readSettings(w.env, w.userHome);
  if (!read.ok) throw new Error(read.message);
  const settings: RunnerSettings = read.settings;
  const pieces: string[] = [];
  const result = await runCodexApp(
    settings,
    { model: MODEL, prompt: 'Say hello.', sendBy: null },
    { onDelta: (text: string) => pieces.push(text), onSent: () => null },
  );
  return { w, pieces, result };
}

const reasoning = [
  ['item/started', { startedAtMs: 0, item: { id: 'r-1', type: 'reasoning' } }],
  ['item/reasoning/textDelta', { itemId: 'r-1', delta: 'PRIVATE-THOUGHT', contentIndex: 0 }],
  ['item/reasoning/summaryTextDelta', { itemId: 'r-1', delta: 'PRIVATE-SUMMARY', summaryIndex: 0 }],
  ['item/completed', { item: { id: 'r-1', type: 'reasoning' } }],
];

describe("the model's reasoning", () => {
  it('reaches no piece, and the answer is still given', async () => {
    const { pieces, result } = await run({ before: reasoning });
    expect(pieces.join('')).not.toContain('PRIVATE');
    expect(pieces).toEqual(['Two tasks', ' are due.']);
    expect(result).toMatchObject({ text: 'Two tasks are due.', failed: false });
  });
});

describe('a call the grammar stops', () => {
  it.each([
    ['a command', { id: 'c-1', type: 'commandExecution', command: 'ls', status: 'inProgress' }],
    ['a web search', { id: 'w-1', type: 'webSearch', query: 'board' }],
    ['a file change', { id: 'f-1', type: 'fileChange', changes: [], status: 'inProgress' }],
  ])('is unknown when the model reaches for %s, and gives no piece', async (_label, item) => {
    const { pieces, result } = await run({
      before: [['item/started', { startedAtMs: 0, item }]],
    });
    expect(result).toBe(UNKNOWN);
    expect(pieces).toEqual([]);
  });

  it.each([
    'item/commandExecution/requestApproval',
    'item/tool/call',
    'account/chatgptAuthTokens/refresh',
  ])('is unknown when the server asks %s, refuses it, and gives no later piece', async (method) => {
    const { w, pieces, result } = await run({ serverRequest: method });
    expect(result).toBe(UNKNOWN);
    expect(pieces).toEqual(['Two tasks']);
    const refused = w
      .appCalls()
      .map((entry) => entry['message'] as Record<string, unknown> | undefined)
      .find((sent) => sent?.['id'] === 'srv-1');
    expect(refused).toMatchObject({ id: 'srv-1', error: { code: -32601 } });
  });

  it('is unknown on a message the grammar does not know', async () => {
    const { result } = await run({ before: [['thread/somethingNew', {}]] });
    expect(result).toBe(UNKNOWN);
  });

  it('is unknown on output that is not JSON-RPC lines', async () => {
    const { result } = await run({ raw: 'not json\n' });
    expect(result).toBe(UNKNOWN);
  });

  it('is unknown when the turn reports no tokens', async () => {
    const { result } = await run({ noUsage: true });
    expect(result).toBe(UNKNOWN);
  });
});

describe('a turn that ends without its answer', () => {
  it('stops the pieces at a second agent message and answers with the last one', async () => {
    const { pieces, result } = await run({ second: ['Actually', ' three.'] });
    expect(pieces).toEqual(['Two tasks', ' are due.']);
    expect(result).toMatchObject({ text: 'Actually three.', failed: false });
  });

  it('is failed, with its tokens, when the turn fails', async () => {
    const { result } = await run({ turnError: { message: 'failed', codexErrorInfo: 'other' } });
    expect(result).toMatchObject({ text: '', failed: true, limited: false, inputTokens: 120 });
  });

  it('is the plan at its limit, having used nothing, when the turn is stopped before any item', async () => {
    const { result } = await run({
      deltas: null,
      noUsage: true,
      turnError: { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' },
    });
    expect(result).toEqual({
      text: '',
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      failed: true,
      limited: true,
    });
  });

  it('waits out an error the server will retry, and fails on one it will not', async () => {
    const retried = await run({
      before: [['error', { willRetry: true, error: { message: 'stream dropped' } }]],
    });
    expect(retried.result).toMatchObject({ text: 'Two tasks are due.', failed: false });
    world?.remove();
    const final = await run({
      before: [['error', { willRetry: false, error: { message: 'gone' } }]],
    });
    expect(final.result).toMatchObject({ text: '', failed: true });
  });
});
