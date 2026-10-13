// SPDX-License-Identifier: AGPL-3.0-only
//
// GPT streamed (LA-1's runner): a streamed call keeps every isolation `codex
// exec` had. The app-server child runs on stdio only, in the runner's empty
// folder and its own Codex home, with the runner's minimal environment and
// every tool feature off. Its thread is ephemeral, read-only and never asks
// for approval. A Codex home holding instructions or a config is refused
// before anything is spawned, and a call leaves no chat text in the runner's home.

import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DISABLED_FEATURES } from '../../apps/local-agent/codex.ts';
import { answerOf, runnerWorld } from './runner-world.ts';
import { CANARY, RUNNER_KEY, type World } from './world.ts';

const PROMPT = 'Which invoices are overdue this week?';
const { start, call } = runnerWorld();

/** One streamed call with this prompt: the world after it, and its answer. */
async function streamedCall(
  prepare: (w: World) => void = () => null,
): Promise<{ w: World; answer: Record<string, unknown> | undefined }> {
  const { w, r } = await start();
  prepare(w);
  const reply = await call(r, { fields: { message: PROMPT }, stream: true });
  return { w, answer: answerOf(reply.raw) };
}

/** The message the runner sent the stand-in by `method`, if it sent one. */
function sent(w: World, method: string): Record<string, unknown> | undefined {
  return w
    .appCalls()
    .map((entry) => entry['message'] as Record<string, unknown> | undefined)
    .find((message) => message?.['method'] === method);
}

describe('the app-server child', () => {
  it('runs on stdio in the empty folder, its own home and environment, every tool off', async () => {
    const { w } = await streamedCall();
    const [started] = w.appCalls();
    const argv = (started?.['argv'] as string[] | undefined) ?? [];
    expect(argv.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    for (const feature of DISABLED_FEATURES) {
      expect(argv.join(' ')).toContain(`--disable ${feature}`);
    }
    expect(argv).toContain('forced_login_method="chatgpt"');
    expect(argv).toContain('web_search="disabled"');
    expect(started?.['cwd']).toBe(realpathSync(join(w.agentHome, 'cwd')));
    const childEnv = (started?.['env'] ?? {}) as Record<string, string>;
    const env = JSON.stringify(childEnv);
    expect(childEnv['CODEX_HOME']).toBe(w.codexHome);
    expect(env).not.toContain(CANARY);
    expect(env).not.toContain(RUNNER_KEY);
  });

  it('starts an ephemeral, read-only thread that never asks for approval', async () => {
    const { w } = await streamedCall();
    expect(sent(w, 'thread/start')?.['params']).toMatchObject({
      cwd: join(w.agentHome, 'cwd'),
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    expect(sent(w, 'turn/start')?.['params']).toMatchObject({
      threadId: 'th-1',
      input: [{ type: 'text', text: PROMPT }],
      effort: 'low',
    });
  });

  it.each(['AGENTS.md', 'AGENTS.override.md', 'config.toml'])(
    'is never spawned while the Codex home holds %s',
    async (name) => {
      const { w, answer } = await streamedCall((world) => {
        writeFileSync(join(world.codexHome, name), 'planted');
      });
      expect(answer).toMatchObject({ text: '', code: 'LOCAL_GPT_FAILED' });
      expect(w.appCalls()).toEqual([]);
      expect(w.calls()).toEqual([]);
    },
  );
});

/** Every file under `dir`, but the stand-in's own knobs and records. */
function files(dir: string): string[] {
  const own = new Set(['fake.json', 'calls.jsonl', 'app-calls.jsonl']);
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((name) => join(dir, name))
    .filter((path) => !own.has(path.split('/').at(-1) ?? '') && statSync(path).isFile());
}

describe("the runner's home after a streamed call", () => {
  it('holds neither the prompt nor the answer', async () => {
    const { w, answer } = await streamedCall();
    expect(answer).toMatchObject({ text: 'Two tasks are due.' });
    for (const file of files(w.agentHome)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain(PROMPT);
      expect(text, file).not.toContain('Two tasks');
    }
  });
});
