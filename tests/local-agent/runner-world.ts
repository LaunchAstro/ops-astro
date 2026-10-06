// SPDX-License-Identifier: AGPL-3.0-only
//
// The local runner's tests' shared harness: a runner started on a throwaway
// laptop (world.ts) and one call to its door, closed and removed after each test.

import { afterEach } from 'vitest';
import { createRunner, type Runner } from '../../apps/local-agent/runner.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { LOCAL_GPT_PATH } from '../../packages/core-connectors/src/index.ts';
import { makeWorld, RUNNER_KEY, type World } from './world.ts';

export interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;
  readonly raw: string;
}

/** One call to a runner's door, as custody makes it (the runner key unless `key` says otherwise). */
export async function call(
  r: Runner,
  body: unknown,
  init: { key?: string | null; path?: string; method?: string; signal?: AbortSignal } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = init.key === undefined ? RUNNER_KEY : init.key;
  if (key !== null) headers['authorization'] = `Bearer ${key}`;
  const method = init.method ?? 'POST';
  const response = await fetch(`${r.origin}${init.path ?? LOCAL_GPT_PATH}`, {
    method,
    headers,
    ...(init.signal === undefined ? {} : { signal: init.signal }),
    ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, raw };
}

export interface RunnerWorld {
  /** What the runners logged in this test. */
  readonly logged: string[];
  readonly opened: Runner[];
  start(
    overrides?: Readonly<Record<string, string | undefined>>,
    w?: World,
  ): Promise<{ w: World; r: Runner }>;
  call(
    r: Runner,
    body: unknown,
    init?: { key?: string | null; path?: string; method?: string; signal?: AbortSignal },
  ): Promise<Reply>;
  /** A laptop the test made itself, removed after it like the others. */
  own(w: World): void;
}

/** Runners started on throwaway laptops, closed and removed after each test. */
export function runnerWorld(): RunnerWorld {
  const logged: string[] = [];
  const opened: Runner[] = [];
  let world: World | undefined;
  afterEach(async () => {
    logged.length = 0;
    await Promise.all(opened.splice(0).map(async (runner) => await runner.close()));
    world?.remove();
    world = undefined;
  });

  async function start(
    overrides: Readonly<Record<string, string | undefined>> = {},
    w: World = makeWorld(),
  ): Promise<{ w: World; r: Runner }> {
    world = w;
    const read = readSettings({ ...w.env, ...overrides }, w.userHome);
    if (!read.ok) throw new Error(`settings refused: ${read.code}`);
    const r = await createRunner(read.settings, (line) => logged.push(line));
    opened.push(r);
    return { w, r };
  }

  const own = (w: World): void => {
    world = w;
  };
  return { logged, opened, start, call, own: (w: World): void => own(w) };
}
