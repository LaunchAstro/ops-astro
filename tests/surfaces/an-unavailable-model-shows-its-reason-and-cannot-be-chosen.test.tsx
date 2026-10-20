// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #2175, the drawer's model picker: a model `conversation.models` names as
// unavailable shows after the offered ones, labelled unavailable with its
// reason as the option's title, and cannot be chosen. The picker's default and
// its "no model on offer" rule count only the models on offer. The operations
// client is a recorder standing in for the network only, as in
// `assistant-model-picker-sends-the-choice.test.tsx`.

import { afterEach, describe, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const CONVERSATION = '55555555-5555-4555-8555-555555555555';
const OFFERED = [
  { id: 'replay-1', provider: 'replay', reach: 'local', ceilingMinor: 500 },
  { id: 'replay-2', provider: 'replay', reach: 'local', ceilingMinor: 500 },
];
const REASON =
  'GPT is not signed in to the ChatGPT plan, so nothing was sent. ' +
  'Your message is kept; choose another model, or have GPT signed in again.';
const UNAVAILABLE = [
  {
    id: 'gpt-plan',
    provider: 'local_gpt',
    label: 'GPT on the ChatGPT plan',
    code: 'GPT_SIGNED_OUT',
    words: REASON,
  },
  { id: 'gpt-bare', provider: 'local_gpt', code: 'GPT_SIGNED_OUT', words: REASON },
];

interface Call {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

function recorder(models: readonly unknown[]): {
  readonly client: OperationsClient;
  readonly sent: Call[];
} {
  const sent: Call[] = [];
  const client = {
    read: async (name: string) => {
      if (name !== 'conversation.models') {
        return await Promise.resolve({ unavailable: true, because: 'not asked here' });
      }
      return await Promise.resolve({
        ok: true,
        value: { ok: true, models, chosen: null, unavailable: UNAVAILABLE },
      });
    },
    mutate: async (name: string, body: Readonly<Record<string, unknown>>) => {
      sent.push({ name, body });
      return await Promise.resolve({
        ok: true,
        value: { recordId: '', revision: 0, detail: { conversationId: CONVERSATION } },
      });
    },
  } as unknown as OperationsClient;
  return { client, sent };
}

async function view(models: readonly unknown[]) {
  const { client, sent } = recorder(models);
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
  return { page, sent };
}

const picker = (page: Awaited<ReturnType<typeof view>>['page']): HTMLSelectElement => {
  const found = page.find('select[data-assistant="model"]');
  if (!(found instanceof HTMLSelectElement)) throw new Error('no model picker');
  return found;
};

describe('#2175 an unavailable model in the picker', () => {
  it('shows after the offered ones, labelled unavailable, with its reason as the title', async () => {
    const { page } = await view(OFFERED);
    const options = [...picker(page).options];
    expect(options.map((option) => option.value)).toStrictEqual([
      'replay-1',
      'replay-2',
      'gpt-plan',
      'gpt-bare',
    ]);
    expect(options.map((option) => option.disabled)).toStrictEqual([false, false, true, true]);
    expect(options[2]?.textContent).toBe('GPT on the ChatGPT plan (unavailable)');
    expect(options[2]?.title).toBe(REASON);
    // No label of its own: the id is shown.
    expect(options[3]?.textContent).toBe('gpt-bare (unavailable)');
    // The offered models read as before, with no reason.
    expect(options[0]?.textContent).toBe('replay-1');
    expect(options[0]?.title).toBe('');
    expect(picker(page).value).toBe('replay-1');
  });

  it('cannot be chosen: a question after trying it is asked of the default', async () => {
    const { page, sent } = await view(OFFERED);
    await page.choose('select[data-assistant="model"]', 'gpt-plan');
    await page.type('[data-assistant="input"]', 'What is due?');
    await press(page, '[data-assistant="input"]', 'Enter');
    await settle();
    expect(sent.map((call) => call.name)).toStrictEqual(['conversation.start']);
    expect(sent[0]?.body).not.toHaveProperty('model');
  });

  it('with none on offer, the picker is empty of choices and disabled', async () => {
    const { page } = await view([]);
    const select = picker(page);
    expect([...select.options].map((option) => option.value)).toStrictEqual([
      'gpt-plan',
      'gpt-bare',
    ]);
    expect(select.disabled).toBe(true);
    expect([...select.options].every((option) => option.disabled)).toBe(true);
  });
});
