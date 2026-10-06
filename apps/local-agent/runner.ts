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
// runner holds a home at a time (home-lock.ts). A call whose caller has gone,
// or whose turn comes as the runner closes, is never run.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { LOCAL_GPT_PATH } from '../../packages/core-connectors/src/index.ts';
import { promptOf, runCodex, UNKNOWN, type CodexResult } from './codex.ts';
import {
  DEFAULT_MODEL,
  decide,
  REFUSAL_MESSAGES,
  UNKNOWN_CALL_TOKENS,
  type CallRefusal,
} from './gate.ts';
import { holdHome } from './home-lock.ts';
import { appendLedger, type LedgerRow } from './ledger.ts';
import type { RunnerSettings } from './settings.ts';

/** A model name the runner passes on: no spaces, no flags, nothing to split. */
const MODEL_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
const MAX_BODY_BYTES = 64 * 1024;
/** A call whose turn comes with under this share of its time left (5 s of 100 s) is not started. */
const MIN_RUN_SHARE = 1 / 20;

export interface LocalAnswer {
  readonly text: string;
  readonly model: string;
  readonly usage: { readonly input: number; readonly output: number };
  readonly code: CallRefusal | null;
}

export interface Runner {
  readonly origin: string;
  /** The address the listener is bound to, as its socket reports it. */
  readonly host: string;
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
  /** The runner is closing: a call whose turn comes now is refused, never run. */
  closing: boolean;
  /** The call in flight, stopped when its caller goes or the runner closes. */
  readonly inFlight: Set<AbortController>;
  /** Calls run one at a time, in arrival order. */
  queue: Promise<unknown>;
}

/** The row a call leaves: its reported tokens, nothing when nothing ran, or UNKNOWN_CALL_TOKENS. */
function rowOf(
  id: string,
  call: CallRequest,
  result: Awaited<ReturnType<typeof runCodex>>,
): LedgerRow {
  const at = new Date().toISOString();
  if (result === null) return { id, at, model: call.model, inputTokens: 0, outputTokens: 0 };
  if (result === UNKNOWN) {
    return { id, at, model: call.model, inputTokens: UNKNOWN_CALL_TOKENS, outputTokens: 0 };
  }
  const { model, inputTokens, outputTokens } = result;
  return { id, at, model, inputTokens, outputTokens };
}

/** A ledger row written; false, and every later call stopped, when it could not be. */
function recorded(settings: RunnerSettings, state: RunnerState, row: LedgerRow): boolean {
  try {
    appendLedger(settings.home, row);
    return true;
  } catch {
    state.ledgerBroken = true;
    return false;
  }
}

/** One call, by its deadline: the gate, a row charged as unknown, then codex, then its own row. */
async function complete(
  settings: RunnerSettings,
  call: CallRequest,
  log: (line: string) => void,
  state: RunnerState,
  { deadline, signal }: { readonly deadline: number; readonly signal: AbortSignal },
): Promise<LocalAnswer> {
  // Custody gives up on the call 120 s after it sent it, however long it queued here.
  const left = deadline - Date.now();
  if (left < settings.timeoutMs * MIN_RUN_SHARE || signal.aborted || state.closing) {
    return refusal(call.model, 'LOCAL_GPT_FAILED');
  }
  if (state.ledgerBroken) {
    log('LOCAL_CAP_REACHED: the ledger could not be written; fix it and restart the runner.');
    return refusal(call.model, 'LOCAL_CAP_REACHED');
  }
  const decision = decide(settings, call.model);
  if (!decision.ok) {
    log(`${decision.code}: ${REFUSAL_MESSAGES[decision.code]}`);
    return refusal(call.model, decision.code);
  }
  // Charged as unknown before anything runs, so a runner stopped mid-call never counts it as nothing.
  const id = randomUUID();
  if (!recorded(settings, state, rowOf(id, call, UNKNOWN))) {
    return refusal(call.model, 'LOCAL_GPT_FAILED');
  }
  const run = { ...settings, timeoutMs: Math.min(settings.timeoutMs, left) };
  const result = await runCodex(run, call.model, promptOf(call.fields), signal);
  if (
    !recorded(settings, state, rowOf(id, call, result)) ||
    result === null ||
    result === UNKNOWN
  ) {
    return refusal(call.model, 'LOCAL_GPT_FAILED');
  }
  return answerOf(call, result, decision.tokensLeft, log);
}

/**
 * A finished call's answer. Codex reports usage only at the end, so a call
 * that used more than the tokens left when it was let in is recorded, never answered.
 */
function answerOf(
  call: CallRequest,
  result: CodexResult,
  tokensLeft: number,
  log: (line: string) => void,
): LocalAnswer {
  if (result.inputTokens + result.outputTokens > tokensLeft) {
    log(`LOCAL_CAP_REACHED: ${REFUSAL_MESSAGES.LOCAL_CAP_REACHED}`);
    return refusal(call.model, 'LOCAL_CAP_REACHED');
  }
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

/** Aborted when the caller has gone (its connection closed before the answer was sent). */
function goneWatch(response: ServerResponse): AbortController {
  const gone = new AbortController();
  response.on('close', () => {
    if (!response.writableFinished) gone.abort();
  });
  return gone;
}

/** The one route: checked, read, then queued behind the call in flight. */
function handler(
  settings: RunnerSettings,
  log: (line: string) => void,
  state: RunnerState,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    if ((request.url ?? '') !== LOCAL_GPT_PATH) return send(response, 404);
    if (request.method !== 'POST') return send(response, 405);
    if (!authorised(request, settings.key)) return send(response, 401);
    const deadline = Date.now() + settings.timeoutMs;
    const gone = goneWatch(response);
    const call = await readCall(request);
    if (typeof call === 'number') return send(response, call);
    const turn = state.queue.then(async () => {
      state.inFlight.add(gone);
      try {
        return await complete(settings, call, log, state, { deadline, signal: gone.signal });
      } finally {
        state.inFlight.delete(gone);
      }
    });
    state.queue = turn.catch(() => null);
    send(response, 200, await turn.catch(() => refusal(call.model, 'LOCAL_GPT_FAILED')));
  };
}

/** Start the runner on a loopback port of its own (0 picks one). */
export async function createRunner(
  settings: RunnerSettings,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  port = 0,
): Promise<Runner> {
  const releaseHome = holdHome(settings.home);
  const state: RunnerState = {
    ledgerBroken: false,
    closing: false,
    inFlight: new Set(),
    queue: Promise.resolve(),
  };
  const handle = handler(settings, log, state);
  const server = createServer((request, response) => {
    // A caller that drops mid-body ends only its own request, never the runner.
    handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else send(response, 400);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  // Closed once: a second close waits on the first and lets go of nothing again.
  let closed: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    // The call in flight is killed and its row written, and every answer sent, before the home goes.
    state.closing = true;
    for (const call of state.inFlight) call.abort();
    await state.queue;
    await nextTurn();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    releaseHome();
  };
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    host: address.address,
    port: address.port,
    close: async () => {
      closed ??= close();
      await closed;
    },
  };
}
