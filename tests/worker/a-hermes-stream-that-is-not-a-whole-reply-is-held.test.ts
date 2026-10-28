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
//   - an event that is not a JSON object, or a delta whose content is not
//     text, makes the stream malformed, so it is held.

import { afterEach, describe, expect, it } from 'vitest';
import { hermesRequest, readHermesAnswer } from '../../packages/core-connectors/src/index.ts';
import type { OutboundRequest } from '../../packages/core-custody/src/agent.ts';
import { event } from '../api/openrouter-stand-in-fixture.ts';
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

/** Custody's folded body for `chunks`, sent through the agent to the stand-in Hermes Agent. */
async function folded(chunks: readonly string[]): Promise<Record<string, unknown>> {
  world = await openAgentWorld({ hermes: true });
  const { hermes } = world;
  if (hermes === undefined) throw new Error('no stand-in Hermes Agent');
  hermes.answer = () => ({ status: 200, chunks });
  const call = await world.call();
  await call.line.send('request', call.seal('request', call.body(request())));
  const [answer] = await call.until('answer');
  const outcome = answer?.body as { outbound: { body: string } } | undefined;
  return JSON.parse(outcome?.outbound.body ?? '{}') as Record<string, unknown>;
}

const DONE = 'data: [DONE]\n\n';
const STOP = chunk({}, 'stop');

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
