// SPDX-License-Identifier: AGPL-3.0-only
//
// A throwaway laptop for the local runner's tests: a user home holding the
// owner's own Codex folder, the runner's own home, and the fake `codex`
// binary. Nothing here reaches a model, an account or the real ~/.codex.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const FAKE_CODEX: string = resolve(import.meta.dirname, 'fake-codex.mjs');
export const RUNNER_KEY = 'runner-key-0123456789abcdef0123456789abcdef';
/** A planted key in the runner's environment: it must never leave the runner. */
export const CANARY = 'sk-proj-CANARY-local-agent-7f3e9c';

export interface FakeCall {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export interface World {
  readonly userHome: string;
  readonly agentHome: string;
  /** The runner's own Codex home, where the fake records and reads its knobs. */
  readonly codexHome: string;
  readonly env: Record<string, string | undefined>;
  knobs(knobs: Record<string, unknown>): void;
  calls(): readonly FakeCall[];
  ledger(): readonly Record<string, unknown>[];
  /** A file in the runner's home: a string as it is, anything else as JSON. */
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
  const codexHome = join(agentHome, 'codex');
  mkdirSync(join(userHome, '.codex'), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const calls = join(codexHome, 'calls.jsonl');
  return {
    userHome,
    agentHome,
    codexHome,
    env: {
      OPS_ENVIRONMENT: 'local',
      OPS_LOCAL_AGENT_KEY: RUNNER_KEY,
      OPS_LOCAL_AGENT_HOME: agentHome,
      OPS_LOCAL_AGENT_CODEX_BIN: FAKE_CODEX,
      PATH: process.env['PATH'],
      OPENAI_API_KEY: CANARY,
    },
    knobs: (knobs) => {
      writeFileSync(join(codexHome, 'fake.json'), JSON.stringify(knobs));
    },
    calls: () => readLines(calls) as FakeCall[],
    ledger: () => readLines(join(agentHome, 'ledger.jsonl')) as Record<string, unknown>[],
    write: (name, value) => {
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
