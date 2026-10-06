// SPDX-License-Identifier: AGPL-3.0-only
//
// One `codex exec` call (LA-1, GPT in Claude's place, owner 7 October 2026):
// the prompt on stdin, the answer read from `--json`'s events. The child is
// spawned without a shell, in an empty folder of the runner's (so no
// repository's AGENTS.md is read), on the runner's own Codex home, with no
// saved session, no user config or rules, a read-only sandbox, web search off
// and every tool feature off, and a minimal environment: the runner key, an
// API key or anything else in the runner's own environment never reaches it,
// so the call runs on the ChatGPT plan's login and spends no money.
//
// The events are read as a closed grammar: a type this file does not know
// makes the output unreadable, and any item but the agent's message or its
// reasoning (a command, a file change, a tool or web call) fails the call, so
// a tool that a later Codex turns on by default is caught, not answered.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerSettings } from './settings.ts';

const MAX_STDOUT_BYTES = 1024 * 1024;

/** A model name as the runner passes it on: never an option, never a path. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** Every Codex feature that gives the model a tool or reads the owner's own state. */
export const DISABLED_FEATURES: readonly string[] = [
  'shell_tool',
  'unified_exec',
  'unified_exec_tty',
  'shell_snapshot',
  'apps',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'in_app_browser',
  'multi_agent',
  'plugins',
  'remote_plugin',
  'plugin_sharing',
  'view_image',
  'hooks',
  'skill_search',
  'skill_mcp_dependency_install',
  'tool_suggest',
  'sleep_tool',
  'goals',
  'memories',
];

/** Instruction files Codex reads from its home on every call; the runner's home holds none. */
const HOME_INSTRUCTIONS = ['AGENTS.md', 'AGENTS.override.md'];

export interface CodexResult {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The turn failed, or the model reached for a tool; its tokens still count. */
  readonly failed: boolean;
}

const EVENTS: ReadonlySet<string> = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
]);
const ITEMS: ReadonlySet<string> = new Set(['agent_message', 'reasoning']);

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

interface Reading {
  text: string | undefined;
  usage: { readonly input: number; readonly output: number } | undefined;
  failed: boolean;
}

/** One event into the reading; false when it is not one this grammar knows. */
function readEvent(event: Record<string, unknown>, reading: Reading): boolean {
  const type = event['type'];
  if (typeof type !== 'string' || !EVENTS.has(type)) return false;
  // The turn's usage ends the turn: nothing may follow it and replace its answer.
  if (reading.usage !== undefined) return false;
  if (type === 'turn.failed' || type === 'error') reading.failed = true;
  if (type === 'turn.completed') {
    const usage = record(event['usage']);
    const input = count(usage?.['input_tokens']);
    const output = count(usage?.['output_tokens']);
    if (input === undefined || output === undefined || reading.usage !== undefined) return false;
    reading.usage = { input, output };
  }
  if (!type.startsWith('item.')) return true;
  const item = record(event['item']);
  const kind = item?.['type'];
  if (typeof kind !== 'string') return false;
  if (!ITEMS.has(kind)) reading.failed = true;
  if (type === 'item.completed' && kind === 'agent_message') {
    const text = item?.['text'];
    if (typeof text !== 'string') return false;
    reading.text = text;
  }
  return true;
}

/** Codex's events as one result, or nothing if they are not the grammar above. */
export function readCodexEvents(stdout: string, requested: string): CodexResult | undefined {
  const reading: Reading = { text: undefined, usage: undefined, failed: false };
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    const event = record(parsed);
    if (event === undefined || !readEvent(event, reading)) return undefined;
  }
  const { usage } = reading;
  if (usage === undefined) return undefined;
  const failed = reading.failed || reading.text === undefined;
  return {
    text: failed ? '' : (reading.text ?? ''),
    model: requested,
    inputTokens: usage.input,
    outputTokens: usage.output,
    failed,
  };
}

/** The fields as one prompt: a lone field is its own text, several are named. */
export function promptOf(fields: Readonly<Record<string, string>>): string {
  const entries = Object.entries(fields);
  const [first] = entries;
  if (entries.length === 1 && first !== undefined) return first[1];
  return entries.map(([name, value]) => `${name}:\n${value}`).join('\n\n');
}

export function codexArgs(model: string, cwd: string): string[] {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--model',
    model,
    '-c',
    'model_reasoning_effort="low"',
    '-c',
    'web_search="disabled"',
    ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '--cd',
    cwd,
    '-',
  ];
}

/** A call that ran but whose answer cannot be read: killed, or ended with no result. */
export const UNKNOWN = 'unknown';

/**
 * Run one call. Resolves with Codex's result; `unknown` when the call ran and
 * its output cannot be read (killed at the timeout or the output cap, or ended
 * out of grammar); null when nothing was started (a malformed model, an
 * instruction file in the runner's Codex home, or no binary).
 */
export async function runCodex(
  settings: RunnerSettings,
  model: string,
  prompt: string,
): Promise<CodexResult | typeof UNKNOWN | null> {
  if (!MODEL.test(model)) return null;
  if (HOME_INSTRUCTIONS.some((name) => existsSync(join(settings.codexHome, name)))) return null;
  const cwd = join(settings.home, 'cwd');
  mkdirSync(settings.home, { recursive: true, mode: 0o700 });
  mkdirSync(settings.codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(settings.childEnv.HOME, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true });
  return await new Promise((resolve) => {
    const child = spawn(settings.codexBin, codexArgs(model, cwd), {
      cwd,
      env: { ...settings.childEnv, CODEX_HOME: settings.codexHome },
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
    });
    const parts: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = (result: CodexResult | typeof UNKNOWN | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(UNKNOWN);
    }, settings.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_STDOUT_BYTES) {
        child.kill('SIGKILL');
        finish(UNKNOWN);
        return;
      }
      parts.push(chunk);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const read = readCodexEvents(Buffer.concat(parts).toString('utf8'), model);
      // A codex that exits non-zero or on a signal did not finish its answer, whatever it printed.
      if (read === undefined) finish(UNKNOWN);
      else finish(code === 0 ? read : { ...read, text: '', failed: true });
    });
    child.stdin.on('error', () => null);
    child.stdin.end(prompt);
  });
}
