// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for the model agent on the owner's machine, speaking the carried
// call's sealed messages (`carriage.ts`, `carry-seal.ts`) over a Carriage. It
// hears its doorbell, joins the offered call's line, accepts, and on a sealed
// request within its deadline asks the stand-in Ollama, passing its words on
// as pieces and its whole body as the answer. A case sets how it behaves, so
// it can stay silent, refuse, or never report the write. It is test support:
// the real agent is the M5's own.

import {
  agentTopic,
  callTopic,
  opened,
  SEAL_LIFE_MS,
  sealed,
  sendable,
  type Carriage,
  type CarryKeys,
  type Line,
} from '../../packages/core-custody/src/index.ts';
import { ollamaPieces } from '../../packages/core-connectors/src/index.ts';

/** How the stand-in answers: as the agent would, or one of the ways a case breaks it. */
export type AgentMode = 'run' | 'silent' | 'refuse' | 'unreported' | 'late-answer';

export interface AgentStandIn {
  mode: AgentMode;
  /** Requests it sent to Ollama. */
  readonly sent: string[];
  /** Calls it accepted. */
  readonly accepted: string[];
  /** Lets an `unreported` or `late-answer` call go on. */
  release(): void;
  /** Runs before each accept is sent: a case's chance to change the world after the offer. */
  beforeAccept: (k: string) => Promise<void>;
  /** Runs before the write is reported: a case's chance to see what waits on the send. */
  beforeWritten: () => Promise<void>;
  /** Runs before a request past its deadline is refused: how late the refusal comes. */
  beforeLapse: () => Promise<void>;
  /** Added to the stand-in's own clock, as a machine whose clock disagrees with the function's. */
  clockOffset: number;
  /** Each sealed request it opened: its deadline, and its own clock when it heard it. */
  readonly requests: { readonly deadlineAt: number; readonly heardAt: number }[];
  /** Resolves once Ollama has the request for the `n`th time. */
  dispatched(n: number): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentOptions {
  readonly carriage: Carriage;
  readonly business: string;
  readonly agent: string;
  /** The agent login's own access token. */
  readonly token: string;
  readonly key: string;
  readonly keys: CarryKeys;
  readonly ollama: string;
  /** The stand-in OpenRouter a paid call's request goes to, where the world has one. */
  readonly openrouter?: string;
  readonly runner?: string;
}

/** Seals on `clock`, the agent's own, as a machine seals on its own clock. */
function sendOn(line: Line, key: string, k: string, runner: string, clock: () => number) {
  let seq = 0;
  return async (event: string, body: unknown, numbered = false): Promise<void> => {
    const message = sealed(key, {
      direction: 'agent',
      k,
      runner,
      event,
      seq: numbered ? seq : 0,
      expiresAt: clock() + SEAL_LIFE_MS,
      body: JSON.stringify(body),
    });
    if (numbered) seq += 1;
    await line.send(event as never, message);
  };
}

const nothing = (): void => {};

// oxlint-disable-next-line max-lines-per-function -- the stand-in's doorbell, line and call in one place
export async function carriageAgent(options: AgentOptions): Promise<AgentStandIn> {
  const runner = options.runner ?? crypto.randomUUID();
  let waiting: () => void = nothing;
  const gate = (): Promise<void> =>
    new Promise((resolve) => {
      waiting = resolve;
    });
  const lines: Line[] = [];
  const standIn: AgentStandIn = {
    mode: 'run',
    sent: [],
    accepted: [],
    beforeAccept: async () => {},
    beforeLapse: async () => {},
    beforeWritten: async () => {},
    clockOffset: 0,
    requests: [],
    dispatched: async (n) => {
      for (let tries = 0; tries < 800 && standIn.sent.length < n; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- polls what it sent, in a test
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      if (standIn.sent.length < n) throw new Error('Ollama never had the request');
    },
    release: () => waiting(),
    stop: async () => {
      waiting();
      await Promise.all(lines.map(async (line) => await line.leave()));
    },
  };
  const doorbell = await options.carriage.join(
    agentTopic(options.business, options.agent),
    options.token,
  );
  if (!doorbell.ok) throw new Error('the agent stand-in could not join its doorbell');
  lines.push(doorbell.line);
  /** The agent's own clock: it seals, opens, accepts and checks the deadline on it. */
  const ownClock = (): number => Date.now() + standIn.clockOffset;

  const run = async (line: Line, k: string, request: Record<string, unknown>): Promise<void> => {
    const say = sendOn(line, options.key, k, runner, ownClock);
    if (standIn.mode === 'refuse') {
      await say('refused', { code: 'MODEL_MACHINE_BUSY' });
      return;
    }
    const asked = request['request'] as { destination: string; path: string; body: string };
    const origin = asked.destination === 'openrouter' ? options.openrouter : options.ollama;
    const clock = ownClock();
    standIn.requests.push({ deadlineAt: Number(request['deadlineAt']), heardAt: clock });
    if (!sendable(Number(request['deadlineAt']), clock)) {
      await standIn.beforeLapse();
      await say('refused', { code: 'SEND_LAPSED' });
      return;
    }
    if (standIn.mode !== 'unreported') await say('started', {});
    const responding = fetch(`${origin ?? ''}${asked.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: asked.body,
    });
    standIn.sent.push(asked.body);
    const response = await responding;
    if (standIn.mode === 'unreported') {
      await gate();
      return;
    }
    await standIn.beforeWritten();
    await say('written', {});
    const reader = ollamaPieces();
    let body = '';
    for await (const chunk of response.body ?? []) {
      const text = new TextDecoder().decode(chunk as Uint8Array, { stream: true });
      body += text;
      // oxlint-disable-next-line no-await-in-loop -- pieces go out in order
      for (const piece of reader.push(text)) await say('piece', { text: piece }, true);
    }
    if (standIn.mode === 'late-answer') await gate();
    const outbound = { ok: true, status: response.status, body };
    await say('answer', { kind: 'answered', outbound, credentialKind: 'api_key', account: null });
  };

  doorbell.line.hear((event, payload) => {
    if (event !== 'offer' || standIn.mode === 'silent') return;
    const { k } = payload as { k: string };
    void (async () => {
      const joined = await options.carriage.join(callTopic(options.business, k), options.token);
      if (!joined.ok) return;
      const { line } = joined;
      lines.push(line);
      line.hear((heard, message) => {
        if (heard !== 'request') return;
        const result = opened(options.keys, message, {
          direction: 'broker',
          event: 'request',
          now: ownClock(),
        });
        if (!result.ok || result.sealed.k !== k || result.sealed.runner !== runner) return;
        void run(line, k, result.body as Record<string, unknown>);
      });
      await standIn.beforeAccept(k);
      standIn.accepted.push(k);
      const acceptedAt = ownClock();
      await sendOn(line, options.key, k, runner, ownClock)('accept', { acceptedAt });
    })();
  });
  return standIn;
}
