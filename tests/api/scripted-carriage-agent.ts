// SPDX-License-Identifier: AGPL-3.0-only
//
// A model agent a case scripts message by message, on the agent's own login
// over the test hub: it hears the doorbell, joins the offered call's line and
// hands the case that line, a sealer under the carry key, and the broker's
// requests as they come. Each seal and each open runs on the clock the case
// gives it, as a machine seals and opens on its own clock. The world's own
// stand-in is set silent first, so this one alone answers.

import {
  agentTopic,
  callTopic,
  opened,
  SEAL_LIFE_MS,
  sealed,
  sendable,
  type Line,
} from '../../packages/core-custody/src/index.ts';
import { hubCarriage } from '../support/hub-carriage.ts';
import type { CarriedWorld } from './carried-world.ts';
import { tokenFor } from './fixture.ts';

export interface SealedAs {
  readonly runner: string;
  readonly k?: string;
  readonly seq?: number;
  readonly expiresAt?: number;
}

export interface Request {
  readonly request: { readonly path: string; readonly body: string };
  readonly deadlineAt: number;
}

export interface CallLine {
  /** The call the doorbell offered. */
  readonly k: string;
  readonly line: Line;
  /** The agent clock this call's seals and opens run on. */
  readonly clock: () => number;
  /** An agent message sealed under the carry key, for this call unless `as.k` names another. */
  seal(event: string, body: unknown, as: SealedAs): unknown;
  say(event: string, body: unknown, as: SealedAs): Promise<void>;
  /** The broker's request for `runner`, opened on this call's clock; undefined if none opens within `ms`. */
  request(runner: string, ms?: number): Promise<Request | undefined>;
}

export interface Scripted {
  /** Each call's script, as it ran. */
  readonly runs: Promise<unknown>[];
  stop(): Promise<void>;
}

const pause = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The agent's script for each offered call, its clock `offset` from this machine's. */
// oxlint-disable-next-line max-lines-per-function -- the doorbell, the line and the sealer in one place
export async function scriptedAgent(
  world: CarriedWorld,
  script: (call: CallLine) => Promise<unknown>,
  offset = 0,
): Promise<Scripted> {
  world.agent.mode = 'silent';
  const carriage = hubCarriage(world.hub);
  const token = await tokenFor(world.w.fixture.agent.subject);
  const business = world.w.fixture.business;
  const lines: Line[] = [];
  const runs: Promise<unknown>[] = [];
  const clock = (): number => Date.now() + offset;
  const doorbell = await carriage.join(agentTopic(business, world.carrier.agent), token);
  if (!doorbell.ok) throw new Error('the scripted agent could not join its doorbell');
  lines.push(doorbell.line);
  // oxlint-disable-next-line max-lines-per-function -- one offered call's join, sealer and script
  doorbell.line.hear((event, payload) => {
    if (event !== 'offer') return;
    const { k } = payload as { readonly k: string };
    runs.push(
      (async () => {
        const joined = await carriage.join(callTopic(business, k), token);
        if (!joined.ok) throw new Error('the scripted agent could not join the call');
        const { line } = joined;
        lines.push(line);
        const heard: unknown[] = [];
        line.hear((name, message) => {
          if (name === 'request') heard.push(message);
        });
        const seal = (name: string, body: unknown, as: SealedAs): unknown =>
          sealed(world.key, {
            direction: 'agent',
            k: as.k ?? k,
            runner: as.runner,
            event: name,
            seq: as.seq ?? 0,
            expiresAt: as.expiresAt ?? clock() + SEAL_LIFE_MS,
            body: JSON.stringify(body),
          });
        const call: CallLine = {
          k,
          line,
          clock,
          seal,
          say: async (name, body, as) => {
            await line.send(name as never, seal(name, body, as));
          },
          request: async (runner, ms = 8_000) => {
            const until = Date.now() + ms;
            while (Date.now() < until) {
              for (const message of heard) {
                const open = opened(world.keys, message, {
                  direction: 'broker',
                  event: 'request',
                  now: clock(),
                });
                if (open.ok && open.sealed.k === k && open.sealed.runner === runner) {
                  return open.body as Request;
                }
              }
              // oxlint-disable-next-line no-await-in-loop -- polls what the line delivered, in a test
              await pause(10);
            }
            return undefined; // oxlint-disable-line unicorn/no-useless-undefined -- none opened
          },
        };
        return await script(call);
      })(),
    );
  });
  return {
    runs,
    stop: async () => {
      await Promise.all(lines.map(async (line) => await line.leave()));
    },
  };
}

/**
 * The agent's part after its accept, as the real agent plays it on its own
 * clock: the request opened, the deadline checked, Ollama asked, the write
 * reported, the whole body answered. Answers what happened.
 */
export async function answerAs(
  world: CarriedWorld,
  call: CallLine,
  runner: string,
): Promise<'no request' | 'lapsed' | 'answered'> {
  const asked = await call.request(runner);
  if (asked === undefined) return 'no request';
  if (!sendable(asked.deadlineAt, call.clock())) {
    await call.say('refused', { code: 'SEND_LAPSED' }, { runner });
    return 'lapsed';
  }
  await call.say('started', {}, { runner });
  const response = await fetch(`${world.ollama.origin}${asked.request.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: asked.request.body,
  });
  await call.say('written', {}, { runner });
  const body = await response.text();
  const outbound = { ok: true, status: response.status, body };
  await call.say(
    'answer',
    { kind: 'answered', outbound, credentialKind: 'api_key', account: null },
    { runner },
  );
  return 'answered';
}
