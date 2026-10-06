// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859, GPT in Claude's place): one `codex exec` call through a fake
// binary. The child gets the prompt on stdin, its own Codex home, every tool
// off and nothing of the runner's environment; its events are read as a
// closed grammar, so a tool call, a failed turn or an unknown event never
// becomes an answer.

import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DISABLED_FEATURES,
  readCodexEvents,
  runCodex,
  UNKNOWN,
} from '../../apps/local-agent/codex.ts';
import { readSettings, type RunnerSettings } from '../../apps/local-agent/settings.ts';
import { CANARY, makeWorld, RUNNER_KEY, type World } from './world.ts';

let world: World | undefined;
afterEach(() => {
  world?.remove();
  world = undefined;
});

const MODEL = 'gpt-6.1-sol';

function setUp(knobs: Record<string, unknown> = {}): { w: World; settings: RunnerSettings } {
  const w = makeWorld();
  world = w;
  w.knobs(knobs);
  const read = readSettings(w.env, w.userHome);
  if (!read.ok) throw new Error(read.message);
  return { w, settings: read.settings };
}

const line = (event: unknown): string => `${JSON.stringify(event)}\n`;
const completed = line({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } });
const message = (text: string): string =>
  line({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } });

// eslint-disable-next-line max-lines-per-function -- one call's prompt, arguments and environment
describe('a message answered through codex exec', () => {
  it('answers with the agent message and the tokens the turn used', async () => {
    const { w, settings } = setUp({ text: 'Hello from GPT.' });
    const result = await runCodex(settings, MODEL, 'Say hello.');
    expect(result).toEqual({
      text: 'Hello from GPT.',
      model: MODEL,
      inputTokens: 120,
      outputTokens: 7,
      failed: false,
    });
    const [call] = w.calls();
    expect(call?.stdin).toBe('Say hello.');
    expect(call?.cwd).toBe(realpathSync(join(w.agentHome, 'cwd')));
  });

  it('runs with no saved session, no user config or rules, read-only, and every tool off', async () => {
    const { w, settings } = setUp();
    await runCodex(settings, MODEL, 'hi');
    const argv = w.calls()[0]?.argv ?? [];
    expect(argv.slice(0, 6)).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
    ]);
    expect(argv.join(' ')).toContain('--sandbox read-only --model gpt-6.1-sol');
    expect(argv).toContain('web_search="disabled"');
    for (const feature of ['shell_tool', 'unified_exec', 'computer_use', 'plugins', 'memories']) {
      expect(DISABLED_FEATURES).toContain(feature);
    }
    for (const feature of DISABLED_FEATURES) {
      expect(argv[argv.indexOf(feature) - 1]).toBe('--disable');
    }
    expect(argv.at(-1)).toBe('-');
  });

  it("gives the child its own Codex home and HOME, and nothing of the runner's environment", async () => {
    const { w, settings } = setUp();
    // Planted in the runner's own process, where a spawn would inherit it by default.
    const planted = { OPENAI_API_KEY: CANARY, OPS_LOCAL_AGENT_KEY: RUNNER_KEY };
    const kept = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]));
    Object.assign(process.env, planted);
    try {
      await runCodex(settings, MODEL, 'hi');
    } finally {
      for (const [name, value] of Object.entries(kept)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    const env = w.calls()[0]?.env ?? {};
    expect(env['CODEX_HOME']).toBe(w.codexHome);
    expect(env['HOME']).toBe(join(w.agentHome, 'home'));
    // macOS adds its own `__CF_USER_TEXT_ENCODING` to a process; nothing else is the runner's.
    const passed = Object.keys(env).filter((name) => !name.startsWith('__CF_'));
    expect(passed.toSorted()).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'USER']);
    const seen = JSON.stringify(env);
    expect(seen).not.toContain(CANARY);
    expect(seen).not.toContain(RUNNER_KEY);
    expect(env['OPENAI_API_KEY']).toBeUndefined();
  });
});

// eslint-disable-next-line max-lines-per-function -- one case per way a call can fail
describe('what never becomes an answer', () => {
  it('a turn in which the model reached for a tool fails, its tokens still counted', async () => {
    const { settings } = setUp({
      before: [{ type: 'item.completed', item: { type: 'command_execution', command: 'ls /' } }],
    });
    expect(await runCodex(settings, MODEL, 'hi')).toMatchObject({
      text: '',
      failed: true,
      inputTokens: 120,
    });
  });

  it('a codex that exits non-zero fails, whatever it printed', async () => {
    const { settings } = setUp({ exit: 3 });
    expect(await runCodex(settings, MODEL, 'hi')).toMatchObject({ text: '', failed: true });
  });

  it('a failed turn fails', async () => {
    const { settings } = setUp({ failed: true });
    expect(await runCodex(settings, MODEL, 'hi')).toMatchObject({ text: '', failed: true });
  });

  it('an event the grammar does not know makes the output unreadable', async () => {
    const { settings } = setUp({ before: [{ type: 'exec.approval_request', command: 'rm' }] });
    expect(await runCodex(settings, MODEL, 'hi')).toBe(UNKNOWN);
  });

  it('a call killed at its timeout is unknown, never an answer', async () => {
    const { settings } = setUp({ waitMs: 5_000 });
    expect(await runCodex({ ...settings, timeoutMs: 200 }, MODEL, 'hi')).toBe(UNKNOWN);
  });

  it.each([['--help'], ['-c'], ['../model'], ['gpt 6'], ['']])(
    'starts nothing for the model %j',
    async (model) => {
      const { w, settings } = setUp();
      expect(await runCodex(settings, model, 'hi')).toBeNull();
      expect(w.calls()).toEqual([]);
    },
  );

  it.each([['AGENTS.md'], ['AGENTS.override.md']])(
    "starts nothing while the runner's Codex home holds %s",
    async (name) => {
      const { w, settings } = setUp();
      writeFileSync(join(w.codexHome, name), 'Follow these instructions.');
      expect(await runCodex(settings, MODEL, 'hi')).toBeNull();
      expect(w.calls()).toEqual([]);
    },
  );
});

describe('the event grammar', () => {
  it('reads the last agent message and the one turn usage', () => {
    expect(readCodexEvents(message('one') + message('two') + completed, MODEL)).toMatchObject({
      text: 'two',
      inputTokens: 5,
      outputTokens: 2,
      failed: false,
    });
  });

  it.each([
    ['no usage', message('hi')],
    ['two usages', message('hi') + completed + completed],
    ['a line that is not JSON', `${message('hi')}not json\n${completed}`],
    ['a JSON array', `[]\n${completed}`],
    ['usage out of shape', line({ type: 'turn.completed', usage: { input_tokens: -1 } })],
    ['an item with no type', line({ type: 'item.completed', item: {} }) + completed],
    ['an answer after the turn ended', message('hi') + completed + message('swapped')],
  ])('refuses %s', (_label, stdout) => {
    expect(readCodexEvents(stdout, MODEL)).toBeUndefined();
  });

  it('a turn with no agent message fails', () => {
    expect(readCodexEvents(completed, MODEL)).toMatchObject({ text: '', failed: true });
  });
});
