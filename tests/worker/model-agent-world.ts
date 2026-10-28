// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent's world for its own cases: a stand-in Ollama on loopback
// that counts every chat it parses, custody's real process holding Ollama's
// credential filed as `none`, the agent on a carriage in memory, and the
// broker's side of each call played by the case: it rings the doorbell as the
// database would, joins the call's line, and seals what the function sends.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  agentTopic,
  callTopic,
  deadlineOf,
  opened,
  parseCarryKeys,
  sealed,
  startCustody,
  type Line,
  type OutboundRequest,
  type ProcessCustody,
  type Sealed,
} from '../../packages/core-custody/src/agent.ts';
import { OLLAMA_DEFAULT_MODEL } from '../../packages/core-connectors/src/index.ts';
import { agentCustody } from '../../apps/model-agent/main.ts';
import {
  sse,
  standInOpenRouter,
  type OpenRouterStandIn,
} from '../api/openrouter-stand-in-fixture.ts';
import {
  startModelAgent,
  type AgentCustody,
  type ModelAgent,
  type ModelAgentOptions,
} from '../../apps/model-agent/carrier.ts';
import { ollamaOnLoopback, streamedLines, type LoopbackOllama } from './ollama-on-loopback.ts';
import { memoryCarriage, type MemoryCarriage } from '../support/memory-carriage.ts';

export const carryKey = (): string => randomBytes(32).toString('base64url');

/** The person's words in every chat the cases send. */
export const PROMPT = 'What is due on the Henderson fit-out this week?';
/** The words the stand-in answers with, one line each. */
export const WORDS: readonly string[] = ['Two ', 'tasks ', 'are ', 'due ', 'this ', 'week.'];

/** The chat the function's broker builds for Ollama, as it reaches the agent. */
export function chatRequest(
  body: Record<string, unknown> = {},
  request: Partial<OutboundRequest> = {},
): OutboundRequest {
  return {
    destination: 'ollama',
    path: '/api/chat',
    method: 'POST',
    body: JSON.stringify({
      model: OLLAMA_DEFAULT_MODEL,
      messages: [{ role: 'user', content: PROMPT }],
      stream: true,
      think: false,
      ...body,
    }),
    timeoutMs: 120_000,
    maxResponseBytes: 262_144,
    ...request,
  };
}

export interface Heard {
  readonly event: string;
  readonly seq: number;
  readonly runner: string;
  readonly body: unknown;
  readonly raw: Sealed;
}

/** One call as the broker's side holds it. */
export interface Call {
  readonly k: string;
  readonly line: Line;
  /** The accept's runner, or a made-up one when no accept came. */
  readonly runner: string;
  /** The accept's clock, or the case's own when no accept came. */
  readonly acceptedAt: number;
  readonly accepted: boolean;
  /** Every sealed agent message heard on the line, opened. */
  readonly heard: Heard[];
  /** The request body the function would send: this call's deadline. */
  body(request?: OutboundRequest): { request: OutboundRequest; deadlineAt: number };
  /** A broker message sealed for this call. */
  seal(
    event: string,
    body: unknown,
    fields?: Partial<Omit<Sealed, 'mac'>> & { key?: string },
  ): Sealed;
  /** The heard messages of `event`, once `n` have come or `ms` passed. */
  until(event: string, n?: number, ms?: number): Promise<readonly Heard[]>;
}

/** The made-up key custody presents to the stand-in OpenRouter. */
export const BEARER: string = `or-test-${randomUUID()}`;
/** The made-up key custody presents to the stand-in Hermes Agent. */
export const HERMES_BEARER: string = `hermes-test-${randomUUID()}`;

export interface AgentWorld {
  readonly ollama: LoopbackOllama;
  /** The stand-in OpenRouter, where the world carries paid calls. */
  readonly openrouter: OpenRouterStandIn | undefined;
  /** The stand-in Hermes Agent, an OpenAI-shaped stream, where the world carries its calls. */
  readonly hermes: OpenRouterStandIn | undefined;
  readonly carriage: MemoryCarriage;
  readonly custody: ProcessCustody;
  readonly agent: ModelAgent;
  readonly business: string;
  readonly agentId: string;
  readonly key: string;
  /** Requests the agent handed custody. */
  readonly handed: OutboundRequest[];
  /** What the agent logged. */
  readonly logs: string[];
  /** A new call: the line joined, the doorbell rung, the accept waited for (1.5 s at most). */
  call(): Promise<Call>;
  close(): Promise<void>;
}

export interface WorldOptions {
  /** The agent's keys, the first its sealing key; one fresh key otherwise. */
  readonly keys?: readonly string[];
  readonly now?: () => number;
  readonly load?: () => number;
  /** Wraps custody as the agent sees it, to pause or count a hand-over. */
  readonly wrap?: (custody: AgentCustody) => AgentCustody;
  /** Custody holds a bearer key for a stand-in OpenRouter, and the agent its reference. */
  readonly paid?: boolean;
  /** Custody holds a bearer key for a stand-in Hermes Agent, and the agent its reference. */
  readonly hermes?: boolean;
}

function heardOn(line: Line, keys: ReturnType<typeof keysOf>, k: string): Heard[] {
  const heard: Heard[] = [];
  line.hear((event, message) => {
    const open = opened(keys, message, { direction: 'agent', event, now: Date.now() });
    if (!open.ok || open.sealed.k !== k) return;
    const { seq, runner } = open.sealed;
    heard.push({ event, seq, runner, body: open.body, raw: open.sealed });
  });
  return heard;
}

function keysOf(values: readonly string[]) {
  const parsed = parseCarryKeys(values[0], values[1]);
  if (!parsed.ok) throw new Error('the case named a malformed carry key');
  return parsed.keys;
}

async function untilHeard(heard: readonly Heard[], event: string, n: number, ms: number) {
  const end = Date.now() + ms;
  while (heard.filter((each) => each.event === event).length < n && Date.now() < end) {
    // oxlint-disable-next-line no-await-in-loop -- waits for the agent's messages
    await sleep(10);
  }
  return heard.filter((each) => each.event === event);
}

function writeNoneCredential(folder: string, paid: boolean, hermes: boolean): string {
  const file = join(folder, 'credentials.json');
  const entry = {
    ref: 'ollama_key',
    kind: 'api_key',
    account: 'm5-ollama',
    destination: 'ollama',
    scheme: 'none',
  };
  const bearer = {
    ref: 'openrouter',
    kind: 'api_key',
    account: 'agency-astro-openrouter',
    destination: 'openrouter',
    header: 'authorization',
    scheme: 'bearer',
    value: BEARER,
  };
  const hermesKey = { ...bearer, ref: 'hermes', account: 'm5-hermes', destination: 'hermes' };
  const entries = [
    entry,
    ...(paid ? [bearer] : []),
    ...(hermes ? [{ ...hermesKey, value: HERMES_BEARER }] : []),
  ];
  writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
  return file;
}

// oxlint-disable-next-line max-lines-per-function -- the world and its broker side
export async function openAgentWorld(options: WorldOptions = {}): Promise<AgentWorld> {
  const folder = mkdtempSync(join(tmpdir(), 'model-agent-'));
  const ollama = await ollamaOnLoopback();
  ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
  const paid = options.paid === true;
  const openrouter = paid ? await standInOpenRouter() : undefined;
  const hermes = options.hermes === true ? await standInOpenRouter() : undefined;
  const custody = await startCustody({
    credentialsFile: writeNoneCredential(folder, paid, hermes !== undefined),
    destinations: [
      { key: 'ollama', origin: ollama.origin },
      ...(openrouter === undefined
        ? []
        : [{ key: 'openrouter', origin: openrouter.origin, stream: 'openai_sse' as const }]),
      ...(hermes === undefined
        ? []
        : [{ key: 'hermes', origin: hermes.origin, stream: 'openai_sse' as const }]),
    ],
  });
  if (hermes !== undefined)
    hermes.answer = () => ({ status: 200, chunks: sse('hermes-agent', WORDS, null) });
  if (openrouter !== undefined) {
    openrouter.answer = (request) => ({
      status: 200,
      chunks: sse(String(request.body['model']), WORDS),
    });
  }
  const handed: OutboundRequest[] = [];
  // Each request under its own destination's credential, as the agent's process maps them.
  const mapped = agentCustody(
    {
      credentialRef: 'ollama_key',
      ...(paid ? { openrouterCredentialRef: 'openrouter' } : {}),
      ...(hermes === undefined ? {} : { hermesCredentialRef: 'hermes' }),
    },
    custody,
  );
  const counted: AgentCustody = {
    dispatch: async (request, gate, onPiece) => {
      handed.push(request);
      return await mapped.dispatch(request, gate, onPiece);
    },
  };
  const keyValues = options.keys ?? [carryKey()];
  const key = keyValues[0] ?? '';
  const keys = keysOf(keyValues);
  const business = randomUUID();
  const agentId = randomUUID();
  const carriage = memoryCarriage();
  const logs: string[] = [];
  const agentOptions: ModelAgentOptions = {
    carriage,
    keys,
    key,
    business,
    agent: agentId,
    token: async () => await Promise.resolve('agent-token'),
    custody: options.wrap ? options.wrap(counted) : counted,
    log: (kind) => logs.push(kind),
    ...(options.now ? { now: options.now } : {}),
    ...(options.load ? { load: options.load } : {}),
  };
  const started = await startModelAgent(agentOptions);
  if ('because' in started) throw new Error(`the agent did not start: ${started.because}`);
  const bell = await carriage.join(agentTopic(business, agentId), 'database');
  if (!bell.ok) throw new Error('the doorbell could not be joined');
  const lines: Line[] = [bell.line];
  const call = async (): Promise<Call> => {
    const k = randomUUID();
    const joined = await carriage.join(callTopic(business, k), 'person-token');
    if (!joined.ok) throw new Error('the call line could not be joined');
    lines.push(joined.line);
    const heard = heardOn(joined.line, keys, k);
    await bell.line.send('offer', { c: randomUUID(), k });
    const [accept] = await untilHeard(heard, 'accept', 1, 1_500);
    const acceptedAt = Number((accept?.body as { acceptedAt?: number } | undefined)?.acceptedAt);
    const at = Number.isSafeInteger(acceptedAt) ? acceptedAt : Date.now();
    const runner = accept?.runner ?? randomUUID();
    return {
      k,
      line: joined.line,
      runner,
      acceptedAt: at,
      accepted: accept !== undefined,
      heard,
      body: (request = chatRequest()) => ({ request, deadlineAt: deadlineOf(at) }),
      seal: (event, body, fields = {}) =>
        sealed(fields.key ?? key, {
          direction: fields.direction ?? 'broker',
          k: fields.k ?? k,
          runner: fields.runner ?? runner,
          event,
          seq: fields.seq ?? 0,
          expiresAt: fields.expiresAt ?? Date.now() + 30_000,
          body: fields.body ?? JSON.stringify(body),
        }),
      until: async (event, n = 1, ms = 3_000) => await untilHeard(heard, event, n, ms),
    };
  };
  return {
    ollama,
    openrouter,
    hermes,
    carriage,
    custody,
    agent: started,
    business,
    agentId,
    key,
    handed,
    logs,
    call,
    close: async () => {
      await started.stop();
      for (const line of lines) await line.leave(); // oxlint-disable-line no-await-in-loop
      await custody.stop();
      await ollama.close();
      await openrouter?.close();
      await hermes?.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
