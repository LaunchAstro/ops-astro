// SPDX-License-Identifier: AGPL-3.0-only
//
// #859 (GPT streamed): a streamed call keeps every isolation `codex exec`
// had. The app-server child runs on stdio only, in the runner's empty folder
// and its own Codex home, with the runner's minimal environment and every
// tool feature off. Its thread is ephemeral, read-only and never asks for
// approval. A Codex home holding instructions or a config is refused before
// anything is spawned, and a call leaves no chat text in the runner's home.

import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCodexApp } from '../../apps/local-agent/codex-app.ts';
import { DISABLED_FEATURES } from '../../apps/local-agent/codex.ts';
import { readSettings, type RunnerSettings } from '../../apps/local-agent/settings.ts';
import { runnerWorld } from './runner-world.ts';
import { CANARY, makeWorld, RUNNER_KEY, type World } from './world.ts';

const MODEL = 'gpt-6.1-sol';
const PROMPT = 'Which invoices are overdue this week?';

let world: World | undefined;
afterEach(() => {
  world?.remove();
  world = undefined;
});

function setUp(): { w: World; settings: RunnerSettings } {
  const w = makeWorld();
  world = w;
  w.knobs({});
  const read = readSettings(w.env, w.userHome);
  if (!read.ok) throw new Error(read.message);
  return { w, settings: read.settings };
}

/** The messages the runner sent the stand-in, by method. */
function sent(w: World, method: string): Record<string, unknown> | undefined {
  return w
    .appCalls()
    .map((entry) => entry['message'] as Record<string, unknown> | undefined)
    .find((message) => message?.['method'] === method);
}

describe('the app-server child', () => {
  it('runs on stdio in the empty folder, its own home and environment, every tool off', async () => {
    const { w, settings } = setUp();
    await runCodexApp(settings, MODEL, PROMPT, () => null);
    const [started] = w.appCalls();
    const argv = started?.['argv'] as string[];
    expect(argv.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    for (const feature of DISABLED_FEATURES) {
      expect(argv.join(' ')).toContain(`--disable ${feature}`);
    }
    expect(argv).toContain('forced_login_method="chatgpt"');
    expect(argv).toContain('web_search="disabled"');
    expect(started?.['cwd']).toBe(realpathSync(join(w.agentHome, 'cwd')));
    const env = started?.['env'] as Record<string, string>;
    expect(env['CODEX_HOME']).toBe(w.codexHome);
    expect(JSON.stringify(env)).not.toContain(CANARY);
    expect(JSON.stringify(env)).not.toContain(RUNNER_KEY);
  });

  it('starts an ephemeral, read-only thread that never asks for approval', async () => {
    const { w, settings } = setUp();
    await runCodexApp(settings, MODEL, PROMPT, () => null);
    expect(sent(w, 'thread/start')?.['params']).toMatchObject({
      model: MODEL,
      cwd: realpathSync(join(w.agentHome, 'cwd')),
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
      const { w, settings } = setUp();
      writeFileSync(join(w.codexHome, name), 'planted');
      expect(await runCodexApp(settings, MODEL, PROMPT, () => null)).toBeNull();
      expect(w.appCalls()).toEqual([]);
    },
  );
});

const { start, call } = runnerWorld();

/** Every file under `dir`, but the stand-in's own knobs and records. */
function files(dir: string): string[] {
  const own = new Set(['fake.json', 'calls.jsonl', 'app-calls.jsonl']);
  return readdirSync(dir, { recursive: true, encoding: 'utf8', withFileTypes: false })
    .map((name) => join(dir, name))
    .filter((path) => !own.has(path.split('/').at(-1) ?? ''))
    .filter((path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    });
}

describe("the runner's home after a streamed call", () => {
  it('holds neither the prompt nor the answer', async () => {
    const { w, r } = await start();
    const reply = await call(r, { fields: { message: PROMPT }, stream: true });
    expect(reply.raw).toContain('Two tasks are due.');
    for (const file of files(w.agentHome)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain(PROMPT);
      expect(text, file).not.toContain('Two tasks');
    }
  });
});
