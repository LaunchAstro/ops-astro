// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// CS-7.30, the drawer's model picker: it lists the models `conversation.models`
// answers, a choice made before the tab starts rides in `conversation.start`
// itself (so the first question is asked of it, not the default), and a choice
// in a started tab goes at once by `conversation.set_model`, a question sent
// straight after it waiting for it to land. The
// operations client is a recorder standing in for the network only; the read
// and the write themselves are proven on the real routes in
// `tests/api/conversation-model-choice-reaches-the-call.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const MODELS = [
  { id: 'replay-1', provider: 'replay', reach: 'local', ceilingMinor: 500 },
  { id: 'replay-2', provider: 'replay', reach: 'local', ceilingMinor: 500 },
];

interface Call {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** `hold`, where given, keeps each `conversation.set_model` from answering until it settles. */
function recorder(hold: Promise<void> = Promise.resolve()): {
  readonly client: OperationsClient;
  readonly reads: Call[];
  readonly sent: Call[];
} {
  const reads: Call[] = [];
  const sent: Call[] = [];
  const client = {
    read: async (name: string, body: Readonly<Record<string, unknown>>) => {
      reads.push({ name, body });
      if (name !== 'conversation.models') {
        return await Promise.resolve({ unavailable: true, because: 'not asked here' });
      }
      return await Promise.resolve({ ok: true, value: { ok: true, models: MODELS, chosen: null } });
    },
    mutate: async (name: string, body: Readonly<Record<string, unknown>>) => {
      sent.push({ name, body });
      if (name === 'conversation.set_model') await hold;
      return await Promise.resolve({
        ok: true,
        value: { recordId: '', revision: 0, detail: { conversationId: CONVERSATION } },
      });
    },
  } as unknown as OperationsClient;
  return { client, reads, sent };
}

async function view(hold?: Promise<void>) {
  const { client, reads, sent } = recorder(hold);
  const page = track(
    await mount(
      <AssistantView
        client={client}
        route="agency:settings"
        here="/settings"
        entry={null}
        onClose={() => {}}
      />,
    ),
  );
  await settle();
  return { page, reads, sent };
}

async function ask(page: Awaited<ReturnType<typeof view>>['page'], text: string): Promise<void> {
  await page.type('[data-assistant="input"]', text);
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
}

describe('CS-7.30 the model picker', () => {
  it('lists the models the read answers, for the empty drawer then the started tab', async () => {
    const { page, reads, sent } = await view();
    const options = (): readonly (string | null)[] =>
      page.all('[data-assistant="model"] option').map((option) => option.getAttribute('value'));
    expect(options()).toStrictEqual(['replay-1', 'replay-2']);
    await ask(page, 'What is due?');
    await settle();
    // No choice made: the start names no model, and the default answers.
    expect(sent.find((call) => call.name === 'conversation.start')?.body).not.toHaveProperty(
      'model',
    );
    const asked = reads
      .filter((call) => call.name === 'conversation.models')
      .map((call) => call.body);
    expect(asked).toContainEqual({});
    expect(asked).toContainEqual({ conversationId: CONVERSATION });
    expect(options()).toStrictEqual(['replay-1', 'replay-2']);
  });

  it('a choice before the first question rides in the start; one in a started tab goes at once', async () => {
    const { page, sent } = await view();
    await page.choose('[data-assistant="model"]', 'replay-2');
    expect(sent).toStrictEqual([]);
    await ask(page, 'What is due?');
    expect(sent.map((call) => call.name)).toStrictEqual(['conversation.start']);
    expect(sent[0]?.body).toMatchObject({ body: 'What is due?', model: 'replay-2' });
    await page.choose('[data-assistant="model"]', 'replay-1');
    await settle();
    expect(sent.slice(1)).toStrictEqual([
      { name: 'conversation.set_model', body: { conversationId: CONVERSATION, model: 'replay-1' } },
    ]);
  });
});

describe('CS-7.30 a question after a choice', () => {
  it('in a started tab waits for the choice to land, so it is asked of the model chosen', async () => {
    let land: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      land = resolve;
    });
    const { page, sent } = await view(held);
    await ask(page, 'What is due?');
    await page.choose('[data-assistant="model"]', 'replay-2');
    await ask(page, 'And next week?');
    await settle();
    // The choice is out but not landed: the question has not gone.
    expect(sent.map((call) => call.name)).toStrictEqual([
      'conversation.start',
      'conversation.set_model',
    ]);
    land?.();
    await settle();
    expect(sent.slice(1)).toStrictEqual([
      { name: 'conversation.set_model', body: { conversationId: CONVERSATION, model: 'replay-2' } },
      {
        name: 'conversation.message',
        body: { conversationId: CONVERSATION, body: 'And next week?' },
      },
    ]);
  });
});
