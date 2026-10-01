// SPDX-License-Identifier: AGPL-3.0-only
//
// The local runner's door (LA-1, #859): a loopback HTTP server the broker's
// custody dispatches to like any provider destination. One route,
// `POST /v1/local-claude/complete`, behind the runner's own bearer key; custody
// holds that key, and the Claude login stays inside Claude Code.
//
// A request names a model (Haiku when it names none) and its fields; the
// answer is `{ text, model, usage: { input, output }, code, costUsd }`. A
// refusal answers 200 with no text, no usage and its code, which the broker's
// operation lists as proof that nothing happened, so it moves no money. Calls
// run one at a time: the ledger's total is read and the cap checked with no
// other call in flight, so two calls never both start under the cap.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promptOf, runClaude } from './claude.ts';
import { DEFAULT_MODEL, decide, MODEL_NAME, REFUSAL_MESSAGES, type CallRefusal } from './gate.ts';
import { appendLedger } from './ledger.ts';
import type { RunnerSettings } from './settings.ts';

export const COMPLETE_PATH = '/v1/local-claude/complete';
const MAX_BODY_BYTES = 64 * 1024;

export interface LocalAnswer {
  readonly text: string;
  readonly model: string;
  readonly usage: { readonly input: number; readonly output: number };
  readonly code: CallRefusal | null;
  readonly costUsd: number;
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
  costUsd: 0,
});

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

/** One call: the gate, then Claude Code, then the ledger. */
async function complete(
  settings: RunnerSettings,
  call: CallRequest,
  log: (line: string) => void,
): Promise<LocalAnswer> {
  const decision = decide(settings, call.model);
  if (!decision.ok) {
    log(`${decision.code}: ${REFUSAL_MESSAGES[decision.code]}`);
    return refusal(call.model, decision.code);
  }
  const result = await runClaude(
    settings,
    call.model,
    promptOf(call.fields),
    decision.budgetLeftUsd,
  );
  if (result === null) return refusal(call.model, 'LOCAL_CLAUDE_FAILED');
  appendLedger(settings.home, {
    at: new Date().toISOString(),
    seat: settings.seat,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  });
  if (result.failed) return refusal(call.model, 'LOCAL_CLAUDE_FAILED');
  return {
    text: result.text,
    model: result.model,
    usage: { input: result.inputTokens, output: result.outputTokens },
    code: null,
    costUsd: result.costUsd,
  };
}

/** Start the runner on a loopback port of its own (0 picks one). */
export async function createRunner(
  settings: RunnerSettings,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  port = 0,
): Promise<Runner> {
  let queue: Promise<unknown> = Promise.resolve();
  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      if ((request.url ?? '') !== COMPLETE_PATH) return send(response, 404);
      if (request.method !== 'POST') return send(response, 405);
      if (!authorised(request, settings.key)) return send(response, 401);
      const call = await readCall(request);
      if (typeof call === 'number') return send(response, call);
      const turn = queue.then(async () => await complete(settings, call, log));
      queue = turn.catch(() => null);
      try {
        send(response, 200, await turn);
      } catch {
        send(response, 200, refusal(call.model, 'LOCAL_CLAUDE_FAILED'));
      }
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  if (settings.usageFile === null) {
    log('No seat usage reading is set: the 85% stop is the operator’s to watch (/usage).');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
