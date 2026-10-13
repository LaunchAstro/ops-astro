// SPDX-License-Identifier: AGPL-3.0-only
//
// One streamed call through `codex app-server` (LA-1's runner, streamed: GPT
// on the owner's plan). `codex exec` hands back only the finished message, so a call that
// streams runs the app-server instead, on stdio only (never a socket): one
// JSON-RPC message per line each way. The child is spawned as exec's is, by
// codex.ts, the one file that spawns codex: no shell, the runner's empty folder, its own Codex home, its
// minimal environment, every tool feature off, web search off and a ChatGPT
// login only. The app-server has no flag to skip the home's config, so a home
// holding a `config.toml` is refused like one holding instructions. The thread
// is ephemeral, read-only and never asks for approval.
//
// Its messages are read as a closed grammar (app-grammar.ts). Each piece of
// the first agent message goes to the caller as it arrives; the reasoning
// never does. Any request the server makes of the runner is refused, and the
// call stops as unknown: work may have been done, so it is charged as such,
// and nothing is answered.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DISABLED_FEATURES,
  folders,
  HOME_INSTRUCTIONS,
  MAX_STDOUT_BYTES,
  MODEL,
  spawnCodex,
  UNKNOWN,
} from './codex.ts';
import { freshTurn, readNotification, record, resultOf } from './app-grammar.ts';
import { broken, nextStep, type AppResult, type Ending, type Plan } from './app-steps.ts';
import type { RunnerSettings } from './settings.ts';

/** Files in the Codex home the app-server would read on every call; the runner's holds none. */
const HOME_FILES = [...HOME_INSTRUCTIONS, 'config.toml'];

/** How long a child that was told to stop may take before it is killed. */
const STOP_GRACE_MS = 500;

export function codexAppArgs(): string[] {
  return [
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    'web_search="disabled"',
    // A saved API-key login bills per call: only the ChatGPT plan's login is used.
    '-c',
    'forced_login_method="chatgpt"',
    ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
  ];
}

/** What a streamed call tells its caller as it goes: each piece, and that its turn was sent. */
export interface Listener {
  readonly onDelta: (text: string) => void;
  readonly onSent: () => void;
}

/**
 * The call's conversation, one line at a time: an ending, or nothing while it
 * goes on. It answers the server through `send`, and tells `listener` as it goes.
 */
function conversation(
  plan: Plan,
  send: (message: Record<string, unknown>) => void,
  listener: Listener,
): { readonly read: (line: string) => Ending | null; readonly sent: () => boolean } {
  const turn = freshTurn();
  let turnStarted = false;
  const read = (line: string): Ending | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return broken(turnStarted);
    }
    const message = record(parsed);
    if (message === undefined) return broken(turnStarted);
    const { id, method } = message;
    if (typeof method === 'string' && id !== undefined) {
      // A request of the runner (an approval, a tool, a token refresh): refused, and the call stops.
      send({ id, error: { code: -32601, message: 'refused' } });
      return { result: UNKNOWN, kill: false };
    }
    if (typeof method === 'string') {
      const params = record(message['params']) ?? {};
      const reading = readNotification(method, params, turn, listener.onDelta);
      if (reading === 'refused') return { result: UNKNOWN, kill: true };
      return reading === 'completed' ? { result: resultOf(turn, plan.model), kill: false } : null;
    }
    if (message['error'] !== undefined) return broken(turnStarted);
    const next = nextStep(id, record(message['result']), plan);
    if (next === 'started') return null;
    if (!('method' in next)) return next as Ending;
    if (id === 1) send({ method: 'initialized' });
    send(next);
    if (next['method'] === 'turn/start') {
      turnStarted = true;
      listener.onSent();
    }
    return null;
  };
  return { read, sent: () => turnStarted };
}

/** A stdout reader that hands over each whole line while `onLine` says to go on. */
function lineReader(onLine: (line: string) => boolean): (chunk: string) => void {
  let buffered = '';
  let open = true;
  return (chunk) => {
    buffered += chunk;
    let at = buffered.indexOf('\n');
    while (open && at !== -1) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (line.trim() !== '') open = onLine(line);
      at = buffered.indexOf('\n');
    }
  };
}

/** The app-server child for one call, asked to initialize; spoken to one JSON-RPC message per line. */
function spawnAppServer(
  settings: RunnerSettings,
  cwd: string,
): {
  readonly child: ReturnType<typeof spawnCodex>;
  readonly send: (message: Record<string, unknown>) => void;
} {
  const child = spawnCodex(settings, codexAppArgs(), cwd, true);
  child.stdin.on('error', () => null);
  // Decoded as a stream, so a character split across two chunks is read whole.
  child.stdout.setEncoding('utf8');
  const send = (message: Record<string, unknown>): void => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  // The first request; its answer waits in the paused pipe until the call reads it.
  send({
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'ops-astro-local-agent', version: '1' } },
  });
  return { child, send };
}

/** The Codex a call must find: the runner's own home, and the version pinned, if any. */
const pinned = (settings: RunnerSettings): Pick<Plan, 'codexHome' | 'codexVersion'> => ({
  codexHome: settings.codexHome,
  codexVersion: settings.codexVersion,
});

/**
 * Run one streamed call. Before any thread it checks the Codex it runs, the
 * account it is signed in to and the plan's usage; it starts the turn only
 * inside the send deadline, and tells `listener` when it has. Each piece of
 * the agent's first message goes to `listener` as it arrives. Resolves as
 * `runCodex` does, or as a refusal before the model was asked: Codex's result;
 * `unknown` when the call ran and its answer cannot be read (killed at the
 * timeout or the output cap, stopped by `signal`, out of grammar, or a request
 * the server made); null when nothing was started (a malformed model, a file in
 * the Codex home it would read, a signal already aborted, no binary, or a
 * refused request before the turn).
 */
export async function runCodexApp(
  settings: RunnerSettings,
  call: { readonly model: string; readonly prompt: string; readonly sendBy: number | null },
  listener: Listener,
  signal?: AbortSignal,
): Promise<AppResult> {
  if (!MODEL.test(call.model) || signal?.aborted === true) return null;
  if (HOME_FILES.some((name) => existsSync(join(settings.codexHome, name)))) return null;
  const cwd = folders(settings);
  const { child, send } = spawnAppServer(settings, cwd);
  const { read, sent } = conversation({ ...call, cwd, ...pinned(settings) }, send, listener);
  // Stopped before its turn was sent, the model was never asked: nothing ran, nothing is charged.
  const stopped = (): Ending => ({ result: sent() ? UNKNOWN : null, kill: true });
  return await new Promise((resolve) => {
    const { end, ended } = ender(child, resolve, () => clearTimeout(timer));
    const stop = (): void => end(stopped());
    const timer = setTimeout(stop, settings.timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    let bytes = 0;
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_STDOUT_BYTES) stop();
    });
    child.stdout.on(
      'data',
      lineReader((line) => {
        const settled = ended() ? null : read(line);
        if (settled !== null) end(settled);
        return !ended();
      }),
    );
    child.on('error', () => end({ result: null, kill: true }));
    // A child that leaves before its turn completed did not finish its answer.
    child.on('close', () => end(stopped()));
  });
}

/**
 * A call's one ending. Killed, the child's whole process group goes at once and
 * the call resolves; let go, the child has the grace to leave, then its group is
 * killed and the call resolves either way. It never waits on a pipe that a
 * descendant of the child may hold open.
 */
function ender(
  child: ReturnType<typeof spawnCodex>,
  resolve: (result: AppResult) => void,
  onEnd: () => void,
): { readonly end: (settled: Ending) => void; readonly ended: () => boolean } {
  let ending: Ending | undefined;
  const killGroup = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The group has already gone.
    }
  };
  const end = (settled: Ending): void => {
    if (ending !== undefined) return;
    ending = settled;
    onEnd();
    child.stdin.end();
    if (settled.kill) {
      killGroup();
      resolve(settled.result);
      return;
    }
    const grace = setTimeout(() => {
      killGroup();
      resolve(settled.result);
    }, STOP_GRACE_MS);
    child.once('close', () => {
      clearTimeout(grace);
      killGroup();
      resolve(settled.result);
    });
  };
  return { end, ended: () => ending !== undefined };
}
