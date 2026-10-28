// SPDX-License-Identifier: AGPL-3.0-only
//
// #2270, Sol's proofs on criterion 5: custody's decoded Hermes Agent stream
// becomes a reply only when it is whole. Through the real custody process and
// a stand-in Hermes Agent:
//
//   - control: the stream Hermes Agent sent on the M5 (28 Oct 2026), tool
//     progress events and all, folds to its text and reads as the reply;
//   - a finish other than `stop` (`length`, `cancelled`) stays, so a later
//     `stop` never makes a cut-short or cancelled answer a reply;
//   - an event out of shape anywhere a choice is read (an event, the choices,
//     a choice or its delta that is no object, content that is no text, a
//     finish that is no name) makes the stream malformed, so it is held;
//   - the worst finish reported stays: `error` over any other, any other
//     over `stop`, so OpenRouter's paid reader never settles a failed reply.

import { afterEach, describe, expect, it } from 'vitest';
import {
  hermesRequest,
  openrouterRequest,
  readHermesAnswer,
  readOpenRouterAnswer,
} from '../../packages/core-connectors/src/index.ts';
import type { OutboundRequest } from '../../packages/core-custody/src/agent.ts';
import { event, HAIKU } from '../api/openrouter-stand-in-fixture.ts';
import { openAgentWorld, PROMPT, type AgentWorld } from './model-agent-world.ts';

const WAIT = 15_000;

let world: AgentWorld | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

const request = (): OutboundRequest => {
  const built = hermesRequest({ message: PROMPT });
  return {
    destination: 'hermes',
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: 120_000,
    maxResponseBytes: 512 * 1024,
  };
};

/** One chunk of Hermes Agent's stream: `delta`, and the finish where one is given. */
const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  event({ model: 'hermes-agent', choices: [{ index: 0, delta, finish_reason: finish }] });

/** A tool progress event, as Hermes Agent names it. */
const progress = (payload: Record<string, unknown>): string =>
  `event: hermes.tool.progress\ndata: ${JSON.stringify(payload)}\n\n`;

/** OpenRouter's paid chat as the broker builds it. */
const paid = (): OutboundRequest => {
  const built = openrouterRequest({ message: PROMPT }, undefined, HAIKU);
  return { ...request(), destination: 'openrouter', path: built.path, body: built.body };
};

/** Custody's folded body for `chunks`, sent through the agent to the stand-in Hermes Agent (or OpenRouter). */
async function folded(
  chunks: readonly string[],
  to: 'hermes' | 'openrouter' = 'hermes',
): Promise<Record<string, unknown>> {
  // A test may fold twice: the world still open closes first, so none is left behind.
  await world?.close();
  world = await openAgentWorld(to === 'hermes' ? { hermes: true } : { paid: true });
  const standIn = to === 'hermes' ? world.hermes : world.openrouter;
  if (standIn === undefined) throw new Error('no stand-in');
  standIn.answer = () => ({ status: 200, chunks });
  const call = await world.call();
  const asked = to === 'hermes' ? request() : paid();
  await call.line.send('request', call.seal('request', call.body(asked)));
  const [answer] = await call.until('answer');
  const outcome = answer?.body as { outbound: { body: string } } | undefined;
  return JSON.parse(outcome?.outbound.body ?? '{}') as Record<string, unknown>;
}

/** One chunk of OpenRouter's paid stream finishing `finish`, with text only on a length finish. */
const paidChunk = (finish: string, usage?: unknown): string =>
  event({
    model: HAIKU,
    choices: [
      {
        index: 0,
        delta: { content: finish === 'length' ? 'partial paid reply' : '' },
        finish_reason: finish,
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  });

const DONE = 'data: [DONE]\n\n';
const STOP = chunk({}, 'stop');

// oxlint-disable-next-line max-lines-per-function -- the control and each held stream
describe('a Hermes Agent stream becomes a reply only when whole', () => {
  it(
    'control: the stream recorded on the M5, tool progress and all, reads as its text',
    async () => {
      const body = await folded([
        chunk({ role: 'assistant' }),
        progress({ tool: 'terminal', label: 'python3', toolCallId: 'call_1', status: 'running' }),
        progress({ tool: 'terminal', toolCallId: 'call_1', status: 'completed' }),
        chunk({ content: '2 + 2 = ' }),
        chunk({ content: '4.' }),
        event({
          model: 'hermes-agent',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 34_168, completion_tokens: 63, total_tokens: 34_231 },
        }),
        DONE,
      ]);
      expect(readHermesAnswer(body)).toMatchObject({
        text: '2 + 2 = 4.',
        usage: { inputUnits: 34_168, outputUnits: 63 },
      });
    },
    WAIT,
  );

  it.each(['length', 'cancelled'])(
    'Sol proof, criterion 5: a non-stop finish cannot be erased (%s, then stop)',
    async (finish) => {
      const body = await folded([chunk({ content: 'partial reply' }, finish), STOP, DONE]);
      expect(body['finish_reason']).toBe(finish);
      expect(readHermesAnswer(body)).toBeUndefined();
    },
    WAIT,
  );

  it.each([
    [
      'a delta that is text',
      event({ model: 'hermes-agent', choices: [{ index: 0, delta: 'lost' }] }),
    ],
    [
      'a delta that is a list',
      event({ model: 'hermes-agent', choices: [{ index: 0, delta: ['lost'] }] }),
    ],
    [
      'choices that are no list',
      event({ model: 'hermes-agent', choices: { delta: { content: 'x' } } }),
    ],
    ['a choice that is no object', event({ model: 'hermes-agent', choices: ['lost'] })],
    ['a finish that is no name', chunk({}, 7 as unknown as string)],
  ])(
    'Sol proof, criterion 5: a malformed nested event cannot become a reply (%s)',
    async (_name, strange) => {
      const body = await folded([chunk({ content: 'partial reply' }), strange, STOP, DONE]);
      expect(body['error']).toBe('stream_malformed');
      expect(readHermesAnswer(body)).toBeUndefined();
    },
    WAIT,
  );

  it(
    'Sol proof, correctness: a later error finish is never masked by an earlier length',
    async () => {
      const hermes = await folded([
        chunk({ content: 'partial reply' }, 'length'),
        chunk({}, 'error'),
        DONE,
      ]);
      expect(hermes['finish_reason']).toBe('error');
      expect(readHermesAnswer(hermes)).toBeUndefined();
      const openrouter = await folded(
        [
          paidChunk('length'),
          paidChunk('error', { prompt_tokens: 120, completion_tokens: 12, cost: 0.000_3 }),
          DONE,
        ],
        'openrouter',
      );
      expect(openrouter['finish_reason']).toBe('error');
      expect(readOpenRouterAnswer(openrouter)).toBeUndefined();
    },
    WAIT,
  );

  it.each([
    ['an event that is null', 'data: null\n\n'],
    ['an event that is a list', 'data: [1]\n\n'],
    ['a delta whose content is an object', chunk({ content: { not: 'text' } })],
    ['a delta whose content is a number', chunk({ content: 42 })],
  ])(
    'Sol proof, criterion 5: malformed Hermes events cannot become a reply (%s)',
    async (_name, strange) => {
      const body = await folded([chunk({ content: 'partial reply' }), strange, STOP, DONE]);
      expect(body['error']).toBe('stream_malformed');
      expect(readHermesAnswer(body)).toBeUndefined();
    },
    WAIT,
  );
});
