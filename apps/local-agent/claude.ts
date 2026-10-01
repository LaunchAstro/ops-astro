// SPDX-License-Identifier: AGPL-3.0-only
//
// One headless Claude Code call (LA-1): `claude -p` on the chosen seat, its
// prompt on stdin, its answer read from `--output-format json`. The child is
// spawned without a shell, in an empty folder of the runner's (so no
// repository's CLAUDE.md is read), with no tools, no saved session and no MCP
// servers, and a minimal environment: the runner key, an API key or anything
// else in the runner's own environment never reaches it, so the call runs on
// the seat's subscription login and spends no money. `--max-budget-usd` is
// the budget left under the cap, Claude Code's own second stop.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerSettings } from './settings.ts';

const MAX_STDOUT_BYTES = 1024 * 1024;

export interface ClaudeResult {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** Claude Code said the call failed; its cost still counts. */
  readonly failed: boolean;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Claude Code's JSON result, or nothing if it is not one. */
export function readClaudeResult(stdout: string, requested: string): ClaudeResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const shape = parsed as Record<string, unknown>;
  const cost = shape['total_cost_usd'];
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return undefined;
  const usage = (shape['usage'] ?? {}) as Record<string, unknown>;
  const modelUsage = shape['modelUsage'];
  const [model] =
    modelUsage !== null && typeof modelUsage === 'object' ? Object.keys(modelUsage) : [];
  const failed = shape['is_error'] !== false || typeof shape['result'] !== 'string';
  return {
    text: failed ? '' : (shape['result'] as string),
    model: model ?? requested,
    inputTokens: count(usage['input_tokens']),
    outputTokens: count(usage['output_tokens']),
    costUsd: cost,
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

export function claudeArgs(model: string, budgetLeftUsd: number): string[] {
  const budget = (Math.floor(budgetLeftUsd * 100) / 100).toFixed(2);
  return [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--tools',
    '',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--max-budget-usd',
    budget,
  ];
}

/** Run one call. Resolves with Claude Code's result, or null for any failure to get one. */
export async function runClaude(
  settings: RunnerSettings,
  model: string,
  prompt: string,
  budgetLeftUsd: number,
): Promise<ClaudeResult | null> {
  const cwd = join(settings.home, 'cwd');
  mkdirSync(cwd, { recursive: true });
  return await new Promise((resolve) => {
    const child = spawn(settings.claudeBin, claudeArgs(model, budgetLeftUsd), {
      cwd,
      env: { ...settings.childEnv, CLAUDE_CONFIG_DIR: settings.seatDir },
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
    });
    const parts: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = (result: ClaudeResult | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, settings.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_STDOUT_BYTES) {
        child.kill('SIGKILL');
        finish(null);
        return;
      }
      parts.push(chunk);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const result = readClaudeResult(Buffer.concat(parts).toString('utf8'), model);
      finish(code !== 0 && result === undefined ? null : (result ?? null));
    });
    child.stdin.on('error', () => null);
    child.stdin.end(prompt);
  });
}
