// SPDX-License-Identifier: AGPL-3.0-only
//
// GPT on the owner's plan, streamed (LA-1's runner): `codex exec` hands back only the
// finished message, so a call that asks to stream runs through `codex
// app-server` on stdio, here a stand-in, and each piece of the agent's message
// reaches the caller while the model is still writing. The runner answers such
// a call as NDJSON: a `piece` line per piece, then one `answer` line that is
// exactly the body a whole answer has.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runCodexApp } from '../../apps/local-agent/codex-app.ts';
import { readSettings, type RunnerSettings } from '../../apps/local-agent/settings.ts';
import { LOCAL_GPT_PATH } from '../../packages/core-connectors/src/index.ts';
import { runnerWorld } from './runner-world.ts';
import { makeWorld, RUNNER_KEY, type World } from './world.ts';

const MODEL = 'gpt-6.1-sol';
const message = { fields: { message: 'What is on the board today?' } };

let world: World | undefined;
afterEach(() => {
  world?.remove();
  world = undefined;
});

function setUp(knobs: Record<string, unknown> = {}): { w: World; settings: RunnerSettings } {
  const w = makeWorld();
  world = w;
  w.knobs(knobs);
  const read = readSettings(w.env, w.userHome);
  if (!read.ok) throw new Error(read.message);
  return { w, settings: read.settings };
}

/** What a streamed response gives within `ms`, its reader let go after. */
async function readFor(response: Response, ms: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const decoder = new TextDecoder();
  let text = '';
  const stop = sleep(ms).then(() => null);
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- the stream's chunks, in order, until the bound
    const part = await Promise.race([reader.read(), stop]);
    if (part === null || part.done) break;
    text += decoder.decode(part.value, { stream: true });
    if (text.includes('"piece"')) break;
  }
  reader.releaseLock();
  return text;
}

async function until(test: () => boolean): Promise<void> {
  // eslint-disable-next-line no-await-in-loop -- polls, one look at a time
  for (let tries = 0; tries < 500 && !test(); tries += 1) await sleep(10);
}

describe('an answer streamed through codex app-server', () => {
  it('gives each piece of the message as the model writes it, before the turn ends', async () => {
    const { w, settings } = setUp();
    const gate = join(w.agentHome, 'gate');
    w.knobs({ gate });
    const pieces: string[] = [];
    let settled = false;
    const running = runCodexApp(
      settings,
      { model: MODEL, prompt: 'Say hello.', sendBy: null },
      { onDelta: (text: string) => pieces.push(text), onSent: () => null },
    ).then((result) => {
      settled = true;
      return result;
    });
    await until(() => pieces.length > 0);
    expect(pieces).toEqual(['Two tasks']);
    expect(settled).toBe(false);
    writeFileSync(gate, '');
    expect(await running).toEqual({
      text: 'Two tasks are due.',
      model: MODEL,
      inputTokens: 120,
      outputTokens: 7,
      failed: false,
      limited: false,
    });
    expect(pieces).toEqual(['Two tasks', ' are due.']);
  });
});

const { start, call } = runnerWorld();

/** The runner's NDJSON reply, one parsed object per line. */
const lines = (raw: string): unknown[] =>
  raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);

// eslint-disable-next-line max-lines-per-function -- one case per way a streamed call is answered
describe('the runner answering a call that asks to stream', () => {
  it('answers NDJSON pieces, then the whole answer as its last line', async () => {
    const { r } = await start();
    const reply = await call(r, { ...message, stream: true });
    expect(reply.status).toBe(200);
    expect(lines(reply.raw)).toEqual([
      { sent: true },
      { piece: 'Two tasks' },
      { piece: ' are due.' },
      {
        answer: {
          text: 'Two tasks are due.',
          model: MODEL,
          usage: { input: 120, output: 7 },
          code: null,
        },
      },
    ]);
  });

  it('sends the first piece on the wire while the model is still writing', async () => {
    const { w, r } = await start();
    const gate = join(w.agentHome, 'gate');
    w.knobs({ gate });
    const response = await Promise.race([
      fetch(`${r.origin}${LOCAL_GPT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${RUNNER_KEY}` },
        body: JSON.stringify({ ...message, stream: true }),
      }),
      sleep(2_000).then(() => null),
    ]);
    // What reached the caller in two seconds with the gate shut: on a runner that does not stream, nothing.
    const early = response === null ? '' : await readFor(response, 2_000);
    writeFileSync(gate, '');
    expect(lines(early)).toContainEqual({ piece: 'Two tasks' });
    expect(early).not.toContain('are due');
  });

  it('answers a refusal before any work as the answer line alone', async () => {
    const { w, r } = await start();
    const reply = await call(r, { ...message, model: 'gpt-unapproved', stream: true });
    expect(lines(reply.raw)).toEqual([
      {
        answer: {
          text: '',
          model: 'gpt-unapproved',
          usage: { input: 0, output: 0 },
          code: 'LOCAL_MODEL_NOT_APPROVED',
        },
      },
    ]);
    expect(w.appCalls()).toEqual([]);
  });

  it('answers a call that does not ask to stream exactly as before, through codex exec', async () => {
    const { w, r } = await start();
    w.knobs({ text: 'Two tasks are due.' });
    const reply = await call(r, message);
    expect(reply.raw).toBe(
      JSON.stringify({
        text: 'Two tasks are due.',
        model: MODEL,
        usage: { input: 120, output: 7 },
        code: null,
      }),
    );
    expect(w.calls()).toHaveLength(1);
    expect(w.appCalls()).toEqual([]);
  });
});
