// SPDX-License-Identifier: AGPL-3.0-only
//
// The local runner's door (LA-1, #859): a loopback HTTP server the broker's
// custody dispatches to like any provider destination. One route,
// `POST /v1/local-gpt/complete`, behind the runner's own bearer key; custody
// holds that key, and the ChatGPT login stays inside the runner's Codex home.
//
// A request names a model (the default when it names none) and its fields;
// the answer is `{ text, model, usage: { input, output }, code }`. A refusal
// answers 200 with no text, no usage and its code, which the broker's
// operation lists as proof that nothing happened, so it moves no money. Calls
// run one at a time: the ledger's total is read and the cap checked with no
// other call in flight, so two calls never both start under the cap. One
// runner holds a home at a time (its lock file), so a second runner on the
// same ledger refuses to start. A call whose caller has gone while it queued
// is never run.

import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LOCAL_GPT_PATH } from '../../packages/core-connectors/src/index.ts';
import { promptOf, runCodex, UNKNOWN } from './codex.ts';
import {
  DEFAULT_MODEL,
  decide,
  REFUSAL_MESSAGES,
  UNKNOWN_CALL_TOKENS,
  type CallRefusal,
} from './gate.ts';
import { appendLedger, type LedgerRow } from './ledger.ts';
import type { RunnerSettings } from './settings.ts';

/** A model name the runner passes on: no spaces, no flags, nothing to split. */
const MODEL_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
const MAX_BODY_BYTES = 64 * 1024;

export interface LocalAnswer {
  readonly text: string;
  readonly model: string;
  readonly usage: { readonly input: number; readonly output: number };
  readonly code: CallRefusal | null;
}

export interface Runner {
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}

interface CallRequest {
  readonly model: string;
  readonly fields: Readonly<Record<string, string>>;
}

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

function authorised(request: IncomingMessage, key: string): boolean {
  const header = request.headers['authorization'] ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  return timingSafeEqual(digest(presented), digest(key));
}

/** The request body, or why not: too large, or not the one shape the route takes. */
async function readCall(request: IncomingMessage): Promise<CallRequest | 400 | 413> {
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    bytes += (part as Buffer).length;
    if (bytes > MAX_BODY_BYTES) return 413;
    parts.push(part as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    return 400;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 400;
  const shape = parsed as Record<string, unknown>;
  const model = shape['model'] ?? DEFAULT_MODEL;
  const fields = shape['fields'];
  if (typeof model !== 'string' || !MODEL_NAME.test(model)) return 400;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return 400;
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([, value]) => typeof value === 'string')) {
    return 400;
  }
  return { model, fields: fields as Record<string, string> };
}

const refusal = (model: string, code: CallRefusal): LocalAnswer => ({
  text: '',
  model,
  usage: { input: 0, output: 0 },
  code,
});

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

/** The runner's own state: a ledger row that could not be written stops every later call. */
interface RunnerState {
  ledgerBroken: boolean;
}

/** The row a call leaves: its reported tokens, or UNKNOWN_CALL_TOKENS when they cannot be read. */
function rowOf(
  call: CallRequest,
  result: Exclude<Awaited<ReturnType<typeof runCodex>>, null>,
): LedgerRow {
  const at = new Date().toISOString();
  if (result === UNKNOWN) {
    return { at, model: call.model, inputTokens: UNKNOWN_CALL_TOKENS, outputTokens: 0 };
  }
  const { model, inputTokens, outputTokens } = result;
  return { at, model, inputTokens, outputTokens };
}

/** One call: the gate, then codex, then the ledger. */
async function complete(
  settings: RunnerSettings,
  call: CallRequest,
  log: (line: string) => void,
  state: RunnerState,
): Promise<LocalAnswer> {
  if (state.ledgerBroken) {
    log('LOCAL_CAP_REACHED: the ledger could not be written; fix it and restart the runner.');
    return refusal(call.model, 'LOCAL_CAP_REACHED');
  }
  const decision = decide(settings, call.model);
  if (!decision.ok) {
    log(`${decision.code}: ${REFUSAL_MESSAGES[decision.code]}`);
    return refusal(call.model, decision.code);
  }
  const result = await runCodex(settings, call.model, promptOf(call.fields));
  if (result === null) return refusal(call.model, 'LOCAL_GPT_FAILED');
  try {
    appendLedger(settings.home, rowOf(call, result));
  } catch {
    state.ledgerBroken = true;
    return refusal(call.model, 'LOCAL_GPT_FAILED');
  }
  if (result === UNKNOWN) return refusal(call.model, 'LOCAL_GPT_FAILED');
  if (result.limited) {
    log(`LOCAL_PLAN_LIMIT: ${REFUSAL_MESSAGES.LOCAL_PLAN_LIMIT}`);
    return refusal(call.model, 'LOCAL_PLAN_LIMIT');
  }
  if (result.failed) return refusal(call.model, 'LOCAL_GPT_FAILED');
  return {
    text: result.text,
    model: result.model,
    usage: { input: result.inputTokens, output: result.outputTokens },
    code: null,
  };
}

/** Whether the caller has gone (its connection closed before the answer was sent). */
function goneWatch(response: ServerResponse): () => boolean {
  let gone = false;
  response.on('close', () => {
    gone = !response.writableFinished;
  });
  return () => gone;
}

/**
 * Hold the home for this runner: a second runner on the same ledger would read
 * the same total and both start under the cap. A lock left by a process that
 * has gone is taken over.
 */
function holdHome(home: string): () => void {
  mkdirSync(home, { recursive: true });
  const lock = `${home}/runner.lock`;
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch {
    const holder = Number(readFileSync(lock, 'utf8'));
    if (Number.isSafeInteger(holder) && holder > 0 && alive(holder)) {
      throw new Error('LOCAL_HOME_IN_USE: another runner holds this OPS_LOCAL_AGENT_HOME');
    }
    writeFileSync(lock, String(process.pid));
  }
  return () => {
    rmSync(lock, { force: true });
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start the runner on a loopback port of its own (0 picks one). */
export async function createRunner(
  settings: RunnerSettings,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  port = 0,
): Promise<Runner> {
  const releaseHome = holdHome(settings.home);
  const state: RunnerState = { ledgerBroken: false };
  let queue: Promise<unknown> = Promise.resolve();
  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      if ((request.url ?? '') !== LOCAL_GPT_PATH) return send(response, 404);
      if (request.method !== 'POST') return send(response, 405);
      if (!authorised(request, settings.key)) return send(response, 401);
      const call = await readCall(request);
      if (typeof call === 'number') return send(response, call);
      const gone = goneWatch(response);
      const turn = queue.then(async () =>
        gone()
          ? refusal(call.model, 'LOCAL_GPT_FAILED')
          : await complete(settings, call, log, state),
      );
      queue = turn.catch(() => null);
      try {
        send(response, 200, await turn);
      } catch {
        send(response, 200, refusal(call.model, 'LOCAL_GPT_FAILED'));
      }
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      releaseHome();
    },
  };
}
