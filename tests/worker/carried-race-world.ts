// SPDX-License-Identifier: AGPL-3.0-only
//
// Both ends of a carried call in one process, for the races between them:
// the function's carried custody and one or more real model agents on one
// carriage in memory, with the doorbell rung as the database rings it and the
// send judgement played by the case. Custody for the agents is egress itself,
// in this process, on the same clock as the agent that hands it the call: the
// agent's stamp and custody's check read one host clock, as on the machine.
// The clock is the case's own when it sets one, so a case can put the
// function and the agent at the same instant without sleeping.

import { randomBytes, randomUUID } from 'node:crypto';
import {
  agentTopic,
  parseCarryKeys,
  type Line,
  type OutboundRequest,
} from '../../packages/core-custody/src/agent.ts';
import { carriedCustody } from '../../packages/core-custody/src/carried-custody.ts';
import type { Handoff } from '../../packages/core-custody/src/carriage.ts';
import type { CustodyOutcome } from '../../packages/core-custody/src/custody.ts';
import { parseDestinations, send, type SendGate } from '../../packages/core-custody/src/egress.ts';
import {
  startModelAgent,
  type AgentCustody,
  type ModelAgent,
} from '../../apps/model-agent/carrier.ts';
import { memoryCarriage, type MemoryCarriage } from '../support/memory-carriage.ts';
import { ollamaOnLoopback, streamedLines, type LoopbackOllama } from './ollama-on-loopback.ts';
import { chatRequest, WORDS } from './model-agent-world.ts';

export interface Accept {
  readonly runner: string;
  readonly acceptedAt: number;
  readonly heardAt: number;
}

export interface RaceWorld {
  readonly carriage: MemoryCarriage;
  readonly ollama: LoopbackOllama;
  readonly business: string;
  readonly agentId: string;
  /** The shared clock: the case's own once set, the wall clock until then. */
  readonly clock: { at?: number };
  now(): number;
  /** What happened, in order: `released` (the fence let go), `written` (custody wrote). */
  readonly order: string[];
  /** Resolves once `event` is in the order. */
  noted(event: string): Promise<void>;
  /** Requests custody was handed, by any agent. */
  readonly handed: OutboundRequest[];
  /** A real model agent on the doorbell; `before` runs as custody is handed the call. */
  startAgent(before?: (gate: SendGate) => Promise<void>): Promise<ModelAgent>;
  /** One call through the function's carried custody; `judged` runs inside the send judgement. */
  carry(judged?: (accept: Accept) => Promise<void>): Promise<CustodyOutcome>;
  close(): Promise<void>;
}

const nothing = async (): Promise<void> => {};

// oxlint-disable-next-line max-lines-per-function -- both ends of the call in one place
export async function openRaceWorld(): Promise<RaceWorld> {
  const key = randomBytes(32).toString('base64url');
  const parsed = parseCarryKeys(key);
  if (!parsed.ok) throw new Error('the case made a malformed carry key');
  const { keys } = parsed;
  const ollama = await ollamaOnLoopback();
  ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
  const listed = parseDestinations([{ key: 'ollama', origin: ollama.origin }]);
  if (!listed.ok) throw new Error('the case listed a malformed destination');
  const carriage = memoryCarriage();
  const clock: { at?: number } = {};
  const now = (): number => clock.at ?? Date.now();
  const business = randomUUID();
  const agentId = randomUUID();
  const order: string[] = [];
  const waiting = new Map<string, (() => void)[]>();
  const note = (event: string): void => {
    order.push(event);
    for (const wake of waiting.get(event) ?? []) wake();
    waiting.delete(event);
  };
  const noted = async (event: string): Promise<void> => {
    if (order.includes(event)) return;
    await new Promise<void>((resolve) => {
      waiting.set(event, [...(waiting.get(event) ?? []), resolve]);
    });
  };
  const handed: OutboundRequest[] = [];
  const agents: ModelAgent[] = [];
  const bell = await carriage.join(agentTopic(business, agentId), 'database');
  if (!bell.ok) throw new Error('the doorbell could not be joined');
  const lines: Line[] = [bell.line];

  const custodyFor = (before: (gate: SendGate) => Promise<void>): AgentCustody => ({
    dispatch: async (request, gate, onPiece) => {
      handed.push(request);
      await before(gate);
      const onWritten = (): void => {
        note('written');
        gate.onWritten();
      };
      const decoder = new TextDecoder();
      const outbound = await send(
        listed.destinations,
        request,
        null,
        undefined,
        (chunk) => onPiece(decoder.decode(chunk, { stream: true })),
        { deadlineAt: gate.deadlineAt, onWritten, now },
      );
      if (!outbound.ok && outbound.fault === 'lapsed')
        return { kind: 'refused', started: false, code: 'SEND_LAPSED' };
      return {
        kind: 'answered',
        started: true,
        outbound,
        credentialKind: 'api_key',
        account: null,
      };
    },
  });

  const custody = carriedCustody({ carriage, keys, key, now });
  return {
    carriage,
    ollama,
    business,
    agentId,
    clock,
    now,
    order,
    noted,
    handed,
    startAgent: async (before = nothing) => {
      const agent = await startModelAgent({
        carriage,
        keys,
        key,
        business,
        agent: agentId,
        token: async () => await Promise.resolve('agent-token'),
        custody: custodyFor(before),
        now,
      });
      if ('because' in agent) throw new Error(`the agent did not start: ${agent.because}`);
      agents.push(agent);
      return agent;
    },
    carry: async (judged = nothing) => {
      const callId = randomUUID();
      const handoff: Handoff = {
        businessId: business,
        callId,
        accessToken: 'person-token',
        offer: async () => {
          await bell.line.send('offer', { c: randomUUID(), k: callId });
          return { ok: true };
        },
        fence: async (accept) => {
          await judged(accept);
          return {
            ok: true,
            release: async () => {
              note('released');
              await Promise.resolve();
            },
          };
        },
      };
      return await custody.dispatch('ollama_key', chatRequest(), undefined, undefined, handoff);
    },
    close: async () => {
      for (const agent of agents) await agent.stop(); // oxlint-disable-line no-await-in-loop
      for (const line of lines) await line.leave(); // oxlint-disable-line no-await-in-loop
      await ollama.close();
    },
  };
}
