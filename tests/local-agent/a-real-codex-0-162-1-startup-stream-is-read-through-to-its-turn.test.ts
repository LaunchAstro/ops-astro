// SPDX-License-Identifier: AGPL-3.0-only
//
// GPT streamed (LA-1's runner), against Codex 0.162.1's own words: the
// fixture is the app-server startup stream the installed codex-cli 0.162.1
// gave, captured with the runner's own flags on an empty throwaway Codex home
// (no sign-in, no auth file, no turn, so no model call), then scrubbed of the
// host name, ids, paths and times (the fixture says how). Replayed line for line,
// every notice in it is read without stopping the call: signed out, as it was
// captured, the call says GPT_SIGNED_OUT and charges nothing; with a ChatGPT
// account and a usage reading put in place of those two replies, the real
// thread answer and `thread/started` lead to the turn.

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { answerOf, runnerWorld } from './runner-world.ts';

const FIXTURE = resolve(import.meta.dirname, 'fixtures/codex-0.162.1-app-server-startup.json');
const { start, call } = runnerWorld();
const message = { fields: { message: 'Say hello.' }, stream: true };

/** The methods of what the capture holds, in order. */
const capturedMethods = (): string[] =>
  (
    JSON.parse(readFileSync(FIXTURE, 'utf8')) as { entries: { line: { method?: string } }[] }
  ).entries.map((entry) => entry.line.method ?? 'reply');

describe("a real codex 0.162.1 app-server's startup stream", () => {
  it('holds the notices the runner must read, and no account, path or host of the capture', () => {
    expect(capturedMethods()).toEqual([
      'reply',
      'remoteControl/status/changed',
      'reply',
      'reply',
      'reply',
      'thread/started',
    ]);
    const text = readFileSync(FIXTURE, 'utf8');
    expect(text).not.toMatch(/\/Users\/|\/private\/|\/var\/folders|\.local\b|@[a-z0-9-]+\.[a-z]/iu);
  });

  it('as captured, signed out: says GPT_SIGNED_OUT, asks nothing, charges nothing', async () => {
    const { w, r } = await start({ OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1' });
    w.knobs({ replay: FIXTURE });
    const reply = await call(r, message);
    expect(answerOf(reply.raw)).toMatchObject({ text: '', code: 'GPT_SIGNED_OUT' });
    expect(w.asked()).toEqual([]);
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('with a ChatGPT account and a usage reading in place, reads the real thread answer through to the turn', async () => {
    const { w, r } = await start({ OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1' });
    w.knobs({
      replay: FIXTURE,
      override: {
        'account/read': {
          account: { type: 'chatgpt', email: null, planType: 'pro' },
          requiresOpenaiAuth: true,
        },
        'account/rateLimits/read': {
          rateLimits: {
            primary: { usedPercent: 10, windowDurationMins: 300 },
            secondary: { usedPercent: 20, windowDurationMins: 10_080 },
          },
          ordinaryUsageAllowed: true,
        },
      },
    });
    const reply = await call(r, message);
    expect(answerOf(reply.raw)).toMatchObject({ text: 'Two tasks are due.', code: null });
    expect(w.asked()).toEqual(['Say hello.']);
  });
});
