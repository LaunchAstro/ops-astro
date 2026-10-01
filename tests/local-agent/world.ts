// SPDX-License-Identifier: AGPL-3.0-only
//
// A throwaway laptop for the local runner's tests: a user home holding the
// seat folders, the runner's own home, and the fake `claude` binary. Nothing
// here reaches a model, an account or the real ~/.claude-seat-* folders.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const FAKE_CLAUDE: string = resolve(import.meta.dirname, 'fake-claude.mjs');
export const RUNNER_KEY = 'runner-key-0123456789abcdef0123456789abcdef';
/** A planted key in the runner's environment: it must never leave the runner. */
export const CANARY = 'sk-ant-api03-CANARY-local-agent-7f3e9c';

export interface FakeCall {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export interface World {
  readonly root: string;
  readonly userHome: string;
  readonly agentHome: string;
  readonly env: Record<string, string | undefined>;
  seatDir(seat: string): string;
  knobs(seat: string, knobs: Record<string, unknown>): void;
  calls(seat: string): readonly FakeCall[];
  ledger(): readonly Record<string, unknown>[];
  write(name: string, value: unknown): void;
  remove(): void;
}

/** A JSON-lines file's rows; none when it does not exist. */
function readLines(file: string): unknown[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

export function makeWorld(): World {
  const root = mkdtempSync(join(tmpdir(), 'local-agent-'));
  const userHome = join(root, 'home');
  const agentHome = join(root, 'agent');
  const seatDir = (seat: string): string => join(userHome, `.claude-seat-${seat}`);
  for (const seat of ['hey', 'nathan']) mkdirSync(seatDir(seat), { recursive: true });
  return {
    root,
    userHome,
    agentHome,
    env: {
      OPS_ENVIRONMENT: 'local',
      OPS_LOCAL_AGENT_SEAT: 'hey',
      OPS_LOCAL_AGENT_KEY: RUNNER_KEY,
      OPS_LOCAL_AGENT_HOME: agentHome,
      OPS_LOCAL_AGENT_CLAUDE_BIN: FAKE_CLAUDE,
      PATH: process.env['PATH'],
      ANTHROPIC_API_KEY: CANARY,
    },
    seatDir,
    knobs: (seat, knobs) => {
      writeFileSync(join(seatDir(seat), 'fake.json'), JSON.stringify(knobs));
    },
    calls: (seat) => readLines(join(seatDir(seat), 'calls.jsonl')) as FakeCall[],
    ledger: () => readLines(join(agentHome, 'ledger.jsonl')) as Record<string, unknown>[],
    write: (name, value) => {
      mkdirSync(agentHome, { recursive: true });
      writeFileSync(
        join(agentHome, name),
        typeof value === 'string' ? value : JSON.stringify(value),
      );
    },
    remove: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
