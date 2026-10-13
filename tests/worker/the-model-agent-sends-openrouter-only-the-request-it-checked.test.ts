// SPDX-License-Identifier: AGPL-3.0-only
//
// What the model agent checks of a paid request is what OpenRouter gets, and
// nothing in it can widen what a reply may cost:
//
//   - a body larger than the paid chat's body limit (the size every hold is
//     worked from) is refused sealed, and OpenRouter hears nothing;
//   - a body whose text names a key twice is refused: the agent judges the
//     parsed body, custody sends the text, and a reader that keeps the first
//     of two keys would read the one that was never checked;
//   - a turn that is not an object, or a key named `__proto__`, is refused;
//   - a request sealed for the call in other letters, or for its runner in
//     other letters, is not this call's, and runs nothing;
//   - a paid request to an agent with no OpenRouter settings is refused
//     sealed, and Ollama hears nothing;
//   - OpenRouter's stream deltas that are not text are never shown: only text
//     reaches the line as pieces.

import { afterEach, describe, expect, it } from 'vitest';
import {
  OPENROUTER_BODY_LIMIT,
  openrouterRequest,
} from '../../packages/core-connectors/src/index.ts';
import type { OutboundRequest } from '../../packages/core-custody/src/agent.ts';
import { HAIKU, event } from '../api/openrouter-stand-in-fixture.ts';
import { openAgentWorld, PROMPT, type AgentWorld } from './model-agent-world.ts';

const WAIT = 15_000;

let world: AgentWorld | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

/** The paid chat as the broker builds it for `message`, as it reaches the agent, its body as `text` makes it. */
function paidRequest(
  message: string = PROMPT,
  text: (body: string) => string = (body) => body,
): OutboundRequest {
  const built = openrouterRequest({ message }, undefined, HAIKU);
  return {
    destination: 'openrouter',
    path: built.path,
    method: built.method,
    body: text(built.body),
    timeoutMs: 120_000,
    maxResponseBytes: 512 * 1024,
  };
}

/** The pinned body with `key` written once more before the pinned one, holding `value`. */
const namedTwice =
  (key: string, value: unknown) =>
  (body: string): string =>
    `{${JSON.stringify(key)}:${JSON.stringify(value)},${body.slice(1)}`;

/** One OpenRouter stream event whose delta's content is `content`, whatever it is. */
const delta = (content: unknown): string =>
  event({ id: 'gen-1', model: HAIKU, choices: [{ index: 0, delta: { content } }] });

/** Sent sealed on a fresh call; what the agent answered, and whether anything was sent. */
async function sent(request: OutboundRequest) {
  world = await openAgentWorld({ paid: true });
  const call = await world.call();
  await call.line.send('request', call.seal('request', call.body(request)));
  const [refused] = await call.until('refused', 1, 5_000);
  return { refused: refused?.body, handed: world.handed.length, at: world.openrouter?.received };
}

// oxlint-disable-next-line max-lines-per-function -- the request cases and their control
describe('the paid request the agent sends is the one it checked', () => {
  it(
    'control: a body at the limit is sent',
    async () => {
      const room = OPENROUTER_BODY_LIMIT - Buffer.byteLength(paidRequest('').body);
      const request = paidRequest('a'.repeat(room));
      expect(Buffer.byteLength(request.body)).toBe(OPENROUTER_BODY_LIMIT);
      const { refused, at } = await sent(request);
      expect(refused).toBeUndefined();
      expect(at).toHaveLength(1);
    },
    WAIT,
  );

  it(
    'a body over the limit every hold is worked from is refused, and OpenRouter hears nothing',
    async () => {
      const request = paidRequest('a'.repeat(OPENROUTER_BODY_LIMIT * 4));
      const { refused, handed, at } = await sent(request);
      expect(at, 'OpenRouter was sent a body larger than any hold allows for').toHaveLength(0);
      expect(handed).toBe(0);
      expect(refused).toStrictEqual({ code: 'REQUEST_REFUSED' });
    },
    WAIT,
  );

  it.each([
    ['provider', { data_collection: 'allow', allow_fallbacks: true }],
    ['max_tokens', 1_000_000],
    ['model', 'openai/gpt-5'],
  ])(
    'a body naming %s twice, the unchecked one first, is refused',
    async (key, value) => {
      const request = paidRequest(PROMPT, namedTwice(key, value));
      // The agent's parse keeps the last of the two, the pinned one.
      expect(JSON.parse(request.body)[key]).toStrictEqual(JSON.parse(paidRequest().body)[key]);
      const { refused, handed, at } = await sent(request);
      expect(
        at?.map((one) => one.raw),
        'OpenRouter was sent a key the agent never checked',
      ).toEqual([]);
      expect(handed).toBe(0);
      expect(refused).toStrictEqual({ code: 'REQUEST_REFUSED' });
    },
    WAIT,
  );

  it.each([
    [
      'a turn that is null',
      (body: string) => {
        const parsed = JSON.parse(body) as { messages: unknown[] };
        parsed.messages.push(null);
        return JSON.stringify(parsed);
      },
    ],
    ['a top-level __proto__ key', namedTwice('__proto__', { stream: false })],
    [
      'a __proto__ key in the provider block',
      (body: string) => body.replace('"provider":{', '"provider":{"__proto__":{"order":["x"]},'),
    ],
  ])(
    '%s is refused',
    async (_name, text) => {
      const { refused, handed, at } = await sent(paidRequest(PROMPT, text));
      expect(refused).toStrictEqual({ code: 'REQUEST_REFUSED' });
      expect(handed).toBe(0);
      expect(at).toHaveLength(0);
    },
    WAIT,
  );
});

describe('a sealed paid request for this call in other letters', () => {
  it.each(['k', 'runner'] as const)(
    'its %s in capitals: not this call, nothing runs or is sent',
    async (field) => {
      world = await openAgentWorld({ paid: true });
      const call = await world.call();
      const named = field === 'k' ? call.k.toUpperCase() : call.runner.toUpperCase();
      expect(named).not.toBe(field === 'k' ? call.k : call.runner);
      await call.line.send(
        'request',
        call.seal('request', call.body(paidRequest()), { [field]: named }),
      );
      expect(await call.until('started', 1, 1_500)).toHaveLength(0);
      expect(world.handed).toStrictEqual([]);
      expect(world.openrouter?.received).toHaveLength(0);
      // Control: the same request sealed as the call names itself runs once.
      await call.line.send('request', call.seal('request', call.body(paidRequest())));
      await call.until('answer');
      expect(world.openrouter?.received).toHaveLength(1);
    },
    WAIT,
  );
});

describe('an agent with no OpenRouter settings', () => {
  it(
    'refuses a paid request sealed, and Ollama hears nothing',
    async () => {
      world = await openAgentWorld();
      const call = await world.call();
      await call.line.send('request', call.seal('request', call.body(paidRequest())));
      const [refused] = await call.until('refused');
      expect(refused?.body).toStrictEqual({ code: 'REQUEST_REFUSED' });
      expect(await call.until('answer', 1, 500)).toHaveLength(0);
      expect(world.ollama.seen).toHaveLength(0);
    },
    WAIT,
  );
});

describe('stream deltas that are not text', () => {
  it(
    'are never shown: only text reaches the line',
    async () => {
      world = await openAgentWorld({ paid: true });
      const { openrouter } = world;
      if (openrouter === undefined) throw new Error('no stand-in OpenRouter');
      openrouter.answer = () => ({
        status: 200,
        chunks: [
          delta(42),
          delta({ text: 'object' }),
          delta(['list']),
          delta(null),
          delta(true),
          delta('Only '),
          delta('text.'),
          event({
            id: 'gen-1',
            model: HAIKU,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.000_1 },
          }),
          'data: [DONE]\n\n',
        ],
      });
      const call = await world.call();
      await call.line.send('request', call.seal('request', call.body(paidRequest())));
      await call.until('answer');
      const pieces = call.heard.filter((heard) => heard.event === 'piece');
      for (const piece of pieces)
        expect(typeof (piece.body as { text: unknown }).text).toBe('string');
      expect(pieces.map((piece) => (piece.body as { text: string }).text).join('')).toBe(
        'Only text.',
      );
    },
    WAIT,
  );
});
