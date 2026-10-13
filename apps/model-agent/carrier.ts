// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent (live chat route B): it carries the people's calls to
// Ollama on the owner's machine, and a listed person's paid chat to OpenRouter
// under custody's own key there (#1508). It connects out only, to Realtime, and hears
// offers on its own doorbell, which the database rings with ids.
//
// Per call, under this process's `runner` (a restart is a new one):
// `offered → accepted → running → done`. Accepted: it joined the call's line
// and sent its sealed accept, stamped `A` on its own clock; the deadline is
// `A + W`. Running: only from accepted, in one turn, by the first request
// that opens (the broker's seal, this call and runner, unexpired), passes the
// request check, and comes by the deadline on a machine not too busy. A
// repeat finds it running and is ignored, or done and gets the last word
// again. Done: answered or refused; a request after the deadline is refused
// `SEND_LAPSED`, so the function knows nothing was written. A call is kept
// 10 minutes, and a stopped agent accepts nothing more.
//
// Custody writes only before the deadline and says `written`. The answer is
// custody's own outcome, sent again until `settled`. Custody lost mid-answer
// sends nothing, so the call is held. The log names kinds only.

import { randomUUID } from 'node:crypto';
import {
  ANSWER_RESEND_MS,
  ANSWER_RESENDS,
  CALL_KEPT_MS,
  SEAL_LIFE_MS,
  agentTopic,
  callTopic,
  deadlineOf,
  opened,
  sealed,
  sendable,
  topicOf,
  type CarriedOutcome,
  type Carriage,
  type CarryEvent,
  type CarryKeys,
  type CustodyOutcome,
  type Line,
  type OutboundRequest,
  type Sealed,
} from '../../packages/core-custody/src/agent.ts';
import { piecesFor } from './pieces.ts';
import { chatOf, keysOf, same } from './request-check.ts';

/** Above this one-minute load the machine is too busy to start a model. */
export const BUSY_LOAD = 45;

/** Custody as the agent hands it a call: written by the deadline or not at all. */
export interface AgentCustody {
  dispatch(
    request: OutboundRequest,
    gate: { readonly deadlineAt: number; readonly onWritten: () => void },
    onPiece: (text: string) => void,
  ): Promise<CustodyOutcome>;
}

export interface ModelAgentOptions {
  readonly carriage: Carriage;
  readonly keys: CarryKeys;
  /** The current carry key, which the agent seals with. */
  readonly key: string;
  readonly business: string;
  readonly agent: string;
  /** The agent login's access token now. */
  readonly token: () => Promise<string>;
  readonly custody: AgentCustody;
  readonly now?: () => number;
  /** The machine's one-minute load. */
  readonly load?: () => number;
  /** Each thing the agent does, by kind only. */
  readonly log?: (kind: string) => void;
}

export interface ModelAgent {
  readonly runner: string;
  stop(): Promise<void>;
}

interface Call {
  state: 'offered' | 'accepted' | 'running' | 'done';
  line?: Line;
  acceptedAt?: number;
  /** The final message, answer or refusal, sent again to a repeated request. */
  final?: { readonly event: 'answer' | 'refused'; readonly message: Sealed };
  settled?: boolean;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
}

interface Agent {
  readonly options: ModelAgentOptions;
  readonly runner: string;
  readonly now: () => number;
  readonly log: (kind: string) => void;
  readonly calls: Map<string, Call>;
  stopped: boolean;
}

/** A message for call `k` under this runner, sealed as the agent's and sent on its line. */
function say(agent: Agent, k: string, call: Call, event: CarryEvent, body: unknown, seq = 0) {
  const message = sealed(agent.options.key, {
    direction: 'agent',
    k,
    runner: agent.runner,
    event,
    seq,
    expiresAt: agent.now() + SEAL_LIFE_MS,
    body: JSON.stringify(body),
  });
  void call.line?.send(event, message);
  return message;
}

function later(call: Call, ms: number, then: () => void): void {
  const timer = setTimeout(() => {
    call.timers.delete(timer);
    then();
  }, ms);
  timer.unref();
  call.timers.add(timer);
}

/** The call's last word, kept for a repeated request and sent again until settled. */
function finish(agent: Agent, k: string, call: Call, event: 'answer' | 'refused', body: unknown) {
  call.state = 'done';
  const message = say(agent, k, call, event, body);
  call.final = { event, message };
  agent.log(event);
  const again = (left: number): void => {
    later(call, ANSWER_RESEND_MS, () => {
      if (call.settled === true || left === 0) return;
      void call.line?.send(event, message);
      again(left - 1);
    });
  };
  again(ANSWER_RESENDS);
}

async function run(
  agent: Agent,
  k: string,
  call: Call,
  request: OutboundRequest,
  deadlineAt: number,
) {
  const pieces = piecesFor(request.destination, agent.now, (event, body, seq) =>
    say(agent, k, call, event, body, seq),
  );
  const onWritten = (): void => {
    say(agent, k, call, 'written', {});
    agent.log('written');
  };
  const outcome = await agent.options.custody.dispatch(
    request,
    { deadlineAt, onWritten },
    pieces.push,
  );
  pieces.end();
  // A withheld outcome comes only from a site template route, never a model call's.
  if (outcome.kind === 'worker_lost' || outcome.kind === 'withheld') {
    call.state = 'done';
    agent.log(outcome.kind === 'withheld' ? 'custody withheld' : 'custody lost');
    return;
  }
  if (outcome.kind === 'refused') {
    finish(agent, k, call, 'refused', { code: outcome.code });
    return;
  }
  const { outbound, credentialKind, account } = outcome;
  // Ollama's `none` credential is filed as an API key or a cloud credential, never `replay`;
  // the owner's plan sign-in is the one subscription custody files.
  const kind =
    credentialKind === 'cloud_credential' || credentialKind === 'subscription'
      ? credentialKind
      : 'api_key';
  const answer: CarriedOutcome = { kind: 'answered', outbound, credentialKind: kind, account };
  finish(agent, k, call, 'answer', answer);
}

/** A request heard on call `k`'s line: run once, refuse, or say the last word again. */
function requested(agent: Agent, k: string, call: Call, message: unknown): void {
  const open = opened(agent.options.keys, message, {
    direction: 'broker',
    event: 'request',
    now: agent.now(),
  });
  if (!open.ok || open.sealed.k !== k || open.sealed.runner !== agent.runner) {
    agent.log('request not ours');
    return;
  }
  if (call.state === 'done' && call.final !== undefined) {
    void call.line?.send(call.final.event, call.final.message);
    return;
  }
  if (call.state !== 'accepted' || call.acceptedAt === undefined) return;
  const body = open.body as { request?: unknown; deadlineAt?: unknown } | null;
  const deadlineAt = deadlineOf(call.acceptedAt);
  const chat = body !== null && typeof body === 'object' ? chatOf(body.request) : undefined;
  if (
    chat === undefined ||
    body?.deadlineAt !== deadlineAt ||
    !same(keysOf(body), 'deadlineAt,request')
  ) {
    finish(agent, k, call, 'refused', { code: 'REQUEST_REFUSED' });
  } else if (!sendable(deadlineAt, agent.now())) {
    finish(agent, k, call, 'refused', { code: 'SEND_LAPSED' });
  } else if ((agent.options.load?.() ?? 0) > BUSY_LOAD) {
    finish(agent, k, call, 'refused', { code: 'MODEL_MACHINE_BUSY' });
  } else {
    call.state = 'running';
    say(agent, k, call, 'started', {});
    agent.log('started');
    void run(agent, k, call, chat, deadlineAt);
  }
}

function heard(agent: Agent, k: string, call: Call, event: string, message: unknown): void {
  if (event === 'request') {
    requested(agent, k, call, message);
    return;
  }
  if (event !== 'settled') return;
  const open = opened(agent.options.keys, message, {
    direction: 'broker',
    event,
    now: agent.now(),
  });
  if (!open.ok || open.sealed.k !== k || open.sealed.runner !== agent.runner) return;
  call.settled = true;
  agent.log('settled');
  void call.line?.leave();
}

/** An offer rung on the doorbell: join the call's line and accept, once per call. */
async function onOffer(agent: Agent, message: unknown): Promise<void> {
  const k = (message as { k?: unknown } | null)?.k;
  if (typeof k !== 'string' || agent.calls.has(k) || agent.stopped) return;
  if (topicOf(`carry:${agent.options.business}:call:${k}`) === undefined) return;
  const call: Call = { state: 'offered', timers: new Set() };
  agent.calls.set(k, call);
  later(call, CALL_KEPT_MS, () => {
    for (const timer of call.timers) clearTimeout(timer);
    agent.calls.delete(k);
    void call.line?.leave();
  });
  agent.log('offer');
  const joined = await agent.options.carriage.join(
    callTopic(agent.options.business, k),
    await agent.options.token(),
  );
  if (!joined.ok || agent.stopped) {
    call.state = 'done';
    // Stopped while joining: the line is left, and nothing is accepted.
    if (joined.ok) await joined.line.leave();
    agent.log('call line refused');
    return;
  }
  call.line = joined.line;
  joined.line.hear((event, said) => heard(agent, k, call, event, said));
  call.acceptedAt = agent.now();
  call.state = 'accepted';
  say(agent, k, call, 'accept', { acceptedAt: call.acceptedAt });
  agent.log('accept');
}

export async function startModelAgent(
  options: ModelAgentOptions,
): Promise<ModelAgent | { readonly because: string }> {
  const agent: Agent = {
    options,
    runner: randomUUID(),
    now: options.now ?? Date.now,
    log: options.log ?? (() => {}),
    calls: new Map(),
    stopped: false,
  };
  const bell = await options.carriage.join(
    agentTopic(options.business, options.agent),
    await options.token(),
  );
  if (!bell.ok) return { because: bell.code };
  bell.line.hear((event, message) => {
    if (event === 'offer') void onOffer(agent, message);
  });
  agent.log('listening');
  return {
    runner: agent.runner,
    stop: async () => {
      agent.stopped = true;
      await bell.line.leave();
      for (const call of agent.calls.values()) {
        for (const timer of call.timers) clearTimeout(timer);
        await call.line?.leave(); // oxlint-disable-line no-await-in-loop
      }
      agent.calls.clear();
    },
  };
}
