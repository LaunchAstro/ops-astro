// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent sends OpenRouter one thing: the pinned paid chat, exactly as
// the broker builds it. Every value is checked, nested: the path and method,
// the six top-level keys, an offered model, the answer streamed, its most in
// tokens, the usage asked for, and the provider block with that model's own
// prices per million, no data collection and no fallback. The turns are
// `{role, content}` only, the first the instructions. Any change to any of it
// is refused sealed, custody is handed nothing, and OpenRouter hears nothing.
// The pinned request is sent once, under OpenRouter's own credential, and its
// words come back as the pieces custody decoded.
//
// The agent's settings take OpenRouter's address only as exactly
// `https://openrouter.ai`, with its credential reference; anything else is
// refused at start, naming the field and never its value. With none set, an
// OpenRouter request is refused and custody is asked nothing.

import { afterEach, describe, expect, it } from 'vitest';
import { agentCustody, destinationsOf } from '../../apps/model-agent/main.ts';
import { parseAgentSettings } from '../../apps/model-agent/settings.ts';
import { openrouterRequest } from '../../packages/core-connectors/src/index.ts';
import type { OutboundRequest } from '../../packages/core-custody/src/agent.ts';
import { HAIKU } from '../api/openrouter-stand-in-fixture.ts';
import {
  BEARER,
  carryKey,
  chatRequest,
  openAgentWorld,
  PROMPT,
  WORDS,
  type AgentWorld,
} from './model-agent-world.ts';

const WAIT = 15_000;

let world: AgentWorld | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

type Body = Record<string, unknown> & {
  messages: Record<string, unknown>[];
  provider: Record<string, unknown> & { max_price: Record<string, unknown> };
  usage: Record<string, unknown>;
};

/** The paid chat as the broker builds it, changed by `change`, as it reaches the agent. */
function paidRequest(
  change: (body: Body) => void = () => {},
  request: Partial<OutboundRequest> = {},
): OutboundRequest {
  const built = openrouterRequest(
    { message: PROMPT, earlier: JSON.stringify([{ role: 'agent', body: 'Earlier.' }]) },
    undefined,
    HAIKU,
  );
  const body = JSON.parse(built.body) as Body;
  change(body);
  return {
    destination: 'openrouter',
    path: built.path,
    method: built.method,
    body: JSON.stringify(body),
    timeoutMs: 120_000,
    maxResponseBytes: 512 * 1024,
    ...request,
  };
}

const mutated: readonly [string, OutboundRequest][] = [
  ['max_tokens one more', paidRequest((b) => (b['max_tokens'] = 2049))],
  ['max_tokens missing', paidRequest((b) => delete b['max_tokens'])],
  ['usage not asked for', paidRequest((b) => (b.usage['include'] = false))],
  ['usage with a key more', paidRequest((b) => (b.usage['detail'] = true))],
  ['a raised prompt price', paidRequest((b) => (b.provider.max_price['prompt'] = '0.2'))],
  ['a raised completion price', paidRequest((b) => (b.provider.max_price['completion'] = '9'))],
  ['a price as a number', paidRequest((b) => (b.provider.max_price['prompt'] = 0.1))],
  [
    'max_price dropped',
    paidRequest((b) => delete (b.provider as Record<string, unknown>)['max_price']),
  ],
  ['data collection allowed', paidRequest((b) => (b.provider['data_collection'] = 'allow'))],
  ['fallbacks allowed', paidRequest((b) => (b.provider['allow_fallbacks'] = true))],
  ['a provider key more', paidRequest((b) => (b.provider['order'] = ['anthropic']))],
  ['a max_price key more', paidRequest((b) => (b.provider.max_price['request'] = '1'))],
  ['a models list', paidRequest((b) => (b['models'] = [HAIKU, 'openai/gpt-5']))],
  ['a route', paidRequest((b) => (b['route'] = 'fallback'))],
  ['a turn key more', paidRequest((b) => (b.messages[1] = { ...b.messages[1], name: 'x' }))],
  ['a tool role', paidRequest((b) => (b.messages[1] = { role: 'tool', content: 'x' }))],
  [
    'content not a string',
    paidRequest((b) => (b.messages[1] = { role: 'user', content: [{ type: 'text' }] })),
  ],
  ['no instructions first', paidRequest((b) => b.messages.shift())],
  ['no turns at all', paidRequest((b) => (b.messages = []))],
  [
    'turns not a list',
    paidRequest(
      (b) => ((b as Record<string, unknown>)['messages'] = { role: 'user', content: 'x' }),
    ),
  ],
  ['a model not offered', paidRequest((b) => (b['model'] = 'openai/gpt-5'))],
  ['an answer not streamed', paidRequest((b) => (b['stream'] = false))],
  ['another path', paidRequest(undefined, { path: '/api/v1/completions' })],
  ['another method', paidRequest(undefined, { method: 'PUT' })],
  ['a longer wait', paidRequest(undefined, { timeoutMs: 120_001 })],
  ['a larger answer', paidRequest(undefined, { maxResponseBytes: 512 * 1024 + 1 })],
  ['the paid chat to Ollama', paidRequest(undefined, { destination: 'ollama' })],
  ['an Ollama chat to OpenRouter', chatRequest({}, { destination: 'openrouter' })],
  [
    'an Ollama chat on the paid path',
    chatRequest({}, { destination: 'openrouter', path: '/api/v1/chat/completions' }),
  ],
];

describe('the paid request check', () => {
  it.each(mutated)(
    '%s is refused sealed and reaches no OpenRouter',
    async (_name, request) => {
      world = await openAgentWorld({ paid: true });
      const call = await world.call();
      await call.line.send('request', call.seal('request', call.body(request)));
      const [answer] = await call.until('refused');
      expect(answer?.body).toStrictEqual({ code: 'REQUEST_REFUSED' });
      expect(world.handed).toStrictEqual([]);
      expect(world.openrouter?.received).toHaveLength(0);
      expect(world.ollama.seen).toHaveLength(0);
    },
    WAIT,
  );

  it(
    'control: the pinned paid chat is sent once, under its own key, its decoded words as pieces',
    async () => {
      world = await openAgentWorld({ paid: true });
      const call = await world.call();
      await call.line.send('request', call.seal('request', call.body(paidRequest())));
      await call.until('answer');
      expect(world.openrouter?.received).toHaveLength(1);
      expect(world.openrouter?.received[0]?.authorization).toBe(`Bearer ${BEARER}`);
      expect(world.ollama.seen).toHaveLength(0);
      const shown = call.heard
        .filter((heard) => heard.event === 'piece')
        .map((heard) => (heard.body as { text: string }).text)
        .join('');
      expect(shown).toBe(WORDS.join(''));
    },
    WAIT,
  );
});

const base = {
  business: '7d6f6c1e-8a51-4c43-9a3f-0b8f3c2d9e10',
  agent: '0c5b9a4e-2f1d-4e6b-8c7a-9d3e1f2a4b5c',
  gotrueUrl: 'https://project.supabase.co/auth/v1',
  email: 'm5-models@example.test',
  password: 'a-long-agent-password',
  providerKey: 'sb_publishable_example',
  realtimeUrl: 'wss://project.supabase.co/realtime/v1',
  ollamaOrigin: 'http://127.0.0.1:11434',
  credentialsFile: '/var/lib/model-agent/credentials.json',
  credentialRef: 'ollama_key',
};
const settings = (extra: Record<string, unknown>): string =>
  JSON.stringify({ ...base, carryKey: carryKey(), ...extra });

// oxlint-disable-next-line max-lines-per-function -- each setting refused, and its controls
describe('the paid settings', () => {
  it.each([
    'http://openrouter.ai',
    'https://openrouter.ai/',
    'https://openrouter.ai/api/v1',
    'https://openrouter.ai:443',
    'https://api.openrouter.ai',
    'https://openrouter.ai.example.test',
    'http://127.0.0.1:8080',
    'https://OPENROUTER.AI',
  ])('refuses %s for OpenRouter at start, naming the field and not the value', (origin) => {
    const parsed = parseAgentSettings(
      settings({ openrouterOrigin: origin, openrouterCredentialRef: 'openrouter' }),
    );
    expect(parsed.ok).toBe(false);
    const problem = parsed.ok ? '' : parsed.problem;
    expect(problem).toContain('openrouterOrigin');
    expect(problem).not.toContain(origin);
  });

  it.each([
    ['an address without a reference', { openrouterOrigin: 'https://openrouter.ai' }],
    ['a reference without an address', { openrouterCredentialRef: 'openrouter' }],
    [
      'an empty reference',
      { openrouterOrigin: 'https://openrouter.ai', openrouterCredentialRef: '' },
    ],
    [
      'a reference that is not text',
      { openrouterOrigin: 'https://openrouter.ai', openrouterCredentialRef: 7 },
    ],
  ])('refuses %s', (_name, extra) => {
    expect(parseAgentSettings(settings(extra)).ok).toBe(false);
  });

  it('control: exactly https://openrouter.ai with its reference starts, and custody gets the destination', () => {
    const parsed = parseAgentSettings(
      settings({
        openrouterOrigin: 'https://openrouter.ai',
        openrouterCredentialRef: 'openrouter',
      }),
    );
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(destinationsOf(parsed.settings)).toStrictEqual([
      { key: 'ollama', origin: 'http://127.0.0.1:11434' },
      { key: 'openrouter', origin: 'https://openrouter.ai', stream: 'openai_sse' },
    ]);
  });

  it('control: without OpenRouter settings custody has Ollama only', () => {
    const parsed = parseAgentSettings(settings({}));
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(destinationsOf(parsed.settings)).toStrictEqual([
      { key: 'ollama', origin: 'http://127.0.0.1:11434' },
    ]);
  });

  const gate = { deadlineAt: Date.now() + 60_000, onWritten: () => {} };

  it('each request goes under its own destination’s credential; an OpenRouter one with none set is refused, custody asked nothing', async () => {
    const asked: string[] = [];
    const custody = {
      dispatchBefore: async (ref: string) => {
        asked.push(ref);
        return await Promise.resolve({ kind: 'refused', started: false, code: 'X' } as const);
      },
    };
    const without = agentCustody({ credentialRef: 'ollama_key' }, custody);
    const refused = await without.dispatch(paidRequest(), gate, () => {});
    expect(refused).toMatchObject({ kind: 'refused', started: false });
    expect(asked).toStrictEqual([]);
    const both = agentCustody(
      { credentialRef: 'ollama_key', openrouterCredentialRef: 'openrouter' },
      custody,
    );
    await both.dispatch(paidRequest(), gate, () => {});
    await both.dispatch(chatRequest(), gate, () => {});
    await without.dispatch(chatRequest(), gate, () => {});
    expect(asked).toStrictEqual(['openrouter', 'ollama_key', 'ollama_key']);
  });
});
