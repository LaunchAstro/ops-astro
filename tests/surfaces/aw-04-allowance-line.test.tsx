// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// AW-04 (U10; U7-SCORE's fourth fork): the drawer's planning allowance line,
// drawn in the real drawer (`AssistantView`). The operations client is a
// recorder standing in for the network only; the read itself is proven on the
// real database in `tests/broker/aw-04-planning-allowance-read.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const CONVERSATION = '44444444-4444-4444-8444-444444444444';

interface Asked {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const allowance = (conversation: { spentMinor: number; heldMinor: number }) => ({
  ok: true,
  value: {
    ok: true,
    allowance: { set: false, currency: 'AUD', limitMinor: 5_000, leftMinor: 3_755, conversation },
  },
});

function recorder(answer: (body: Readonly<Record<string, unknown>>) => unknown): {
  readonly client: OperationsClient;
  readonly asked: Asked[];
} {
  const asked: Asked[] = [];
  const client = {
    read: async (name: string, body: Readonly<Record<string, unknown>>) => {
      asked.push({ name, body });
      return await Promise.resolve(answer(body));
    },
    mutate: async () =>
      await Promise.resolve({
        ok: true,
        value: { recordId: '', revision: 0, detail: { conversationId: CONVERSATION } },
      }),
  } as unknown as OperationsClient;
  return { client, asked };
}

async function drawer(answer: (body: Readonly<Record<string, unknown>>) => unknown) {
  const { client, asked } = recorder(answer);
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
  return { page, asked };
}

describe('AW-04 planning allowance read: the drawer', () => {
  it('AW-04 planning allowance read: the empty drawer shows the allowance line before the first message', async () => {
    const { page, asked } = await drawer(() => allowance({ spentMinor: 0, heldMinor: 0 }));
    expect(asked).toStrictEqual([{ name: 'conversation.allowance', body: {} }]);
    expect(page.all('[data-message-role]')).toHaveLength(0);
    expect(page.find('[data-assistant="allowance"]')?.textContent).toBe(
      'Planning allowance: AUD 37.55 left of AUD 50.00.',
    );
  });

  it("AW-04 planning allowance read: a started tab's line adds its own conversation's spend and hold", async () => {
    const { page, asked } = await drawer((body) =>
      allowance(
        body['conversationId'] === CONVERSATION
          ? { spentMinor: 745, heldMinor: 500 }
          : { spentMinor: 0, heldMinor: 0 },
      ),
    );
    await page.type('[data-assistant="input"]', 'Plan the supplier follow-up');
    await press(page, '[data-assistant="input"]', 'Enter');
    await settle();
    expect(asked.at(-1)).toStrictEqual({
      name: 'conversation.allowance',
      body: { conversationId: CONVERSATION },
    });
    expect(page.find('[data-assistant="allowance"]')?.textContent).toBe(
      'Planning allowance: AUD 37.55 left of AUD 50.00. This conversation: AUD 7.45 spent, AUD 5.00 held.',
    );
  });

  it('AW-04 planning allowance read: a refused or unavailable read draws no line and no figure', async () => {
    for (const answer of [
      { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: ['no live grant covers it'] },
      { unavailable: true, because: 'The API answered 503.' },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one drawer per answer
      const { page } = await drawer(() => answer);
      expect(page.find('[data-assistant="allowance"]')).toBeNull();
      expect(page.text()).not.toContain('AUD');
      // eslint-disable-next-line no-await-in-loop
      await unmountAll();
    }
  });
});
