// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// REVIEW-3A-14 (REVIEW-BATCH-2 #312, batch 3a). One start per tab, also after
// a refused start. In `apps/web/src/views/assistant.tsx` (`useSender`), a
// refused first start clears the tab's pending start; the second and third
// questions, queued behind it, each read the refused start's null and each
// start a conversation of their own, so one tab opens two conversations.
// Modelled on `tests/surfaces/mp-7-11-assistant-view.test.tsx` ("two quick
// questions"); the operations client is a recorder.

import { afterEach, describe, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const SECOND = '44444444-4444-4444-8444-444444444444';

interface Sent {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * Every command recorded as sent, each answer held until the test lets it go.
 * The first start is refused; every later command is answered, a start with
 * the conversation `SECOND`.
 */
function recorder(held: Promise<void>): {
  readonly client: OperationsClient;
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];
  let starts = 0;
  const client = {
    mutate: async (name: string, body: Readonly<Record<string, unknown>>) => {
      sent.push({ name, body });
      const first = name === 'conversation.start' && starts === 0;
      if (name === 'conversation.start') starts += 1;
      await held;
      if (first) {
        return {
          ok: false,
          refused: true,
          code: 'FIELD_VALUE_INVALID',
          names: ['body'],
          fixes: ['Try again.'],
        };
      }
      return {
        ok: true,
        value: { recordId: '', revision: 0, detail: { conversationId: SECOND } },
      };
    },
  } as unknown as OperationsClient;
  return { client, sent };
}

async function ask(page: Mounted, text: string): Promise<void> {
  await page.type('[data-assistant="input"]', text);
  await press(page, '[data-assistant="input"]', 'Enter');
}

/** An answer held back until the test lets it go. */
function heldAnswer(): { readonly held: Promise<void>; readonly release: () => void } {
  const released: (() => void)[] = [];
  const held = new Promise<void>((resolve) => {
    released.push(resolve);
  });
  return {
    held,
    release: () => {
      for (const resolve of released) resolve();
    },
  };
}

describe('REVIEW-3A-14 one start per tab after a refusal', () => {
  it('REVIEW-3A-14: after a refused first start, the queued questions open one conversation, and the third joins the second’s', async () => {
    const { held, release } = heldAnswer();
    const { client, sent } = recorder(held);
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
    await ask(page, 'One');
    await ask(page, 'Two');
    await ask(page, 'Three');
    expect(sent.map((call) => call.name)).toStrictEqual(['conversation.start']);
    release();
    await settle();
    await settle();
    await settle();
    const starts = sent.filter((call) => call.name === 'conversation.start');
    expect(
      starts.map((call) => call.body['body']),
      'one tab started more than two conversations: each queued question started its own',
    ).toHaveLength(2);
    expect(sent.find((call) => call.body['body'] === 'Three')).toStrictEqual({
      name: 'conversation.message',
      body: { conversationId: SECOND, body: 'Three' },
    });
  });
});
