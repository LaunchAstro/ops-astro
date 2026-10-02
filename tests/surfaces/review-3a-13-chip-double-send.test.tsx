// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// REVIEW-3A-13 (REVIEW-BATCH-2 #312, batch 3a). One chip press is one
// question. The asker's chip path (`packages/ui/src/surfaces/assistant/asker.tsx`,
// `send(chip, false)`) has no guard, and the drawer's sender
// (`apps/web/src/views/assistant.tsx`, `useSender`) has no in-flight guard, so
// a double press on a chip while the first is still out sends the question
// twice: a `conversation.start` and then a `conversation.message` with the
// same text. Modelled on `tests/surfaces/mp-7-11-assistant-view.test.tsx`
// ("two quick questions"); the operations client is a recorder.

import { afterEach, describe, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const CONVERSATION = '33333333-3333-4333-8333-333333333333';

interface Sent {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Every command recorded as sent, each answer held until the test lets it go. */
function recorder(held: Promise<void>): {
  readonly client: OperationsClient;
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];
  const client = {
    mutate: async (name: string, body: Readonly<Record<string, unknown>>) => {
      sent.push({ name, body });
      await held;
      return {
        ok: true,
        value: { recordId: '', revision: 0, detail: { conversationId: CONVERSATION } },
      };
    },
  } as unknown as OperationsClient;
  return { client, sent };
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

describe('REVIEW-3A-13 chip double press', () => {
  it('REVIEW-3A-13: a chip pressed twice while its answer is out sends the question once', async () => {
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
    const chip = page.find('.aip__chip')?.textContent;
    expect(chip).toBeTruthy();
    await page.click('.aip__chip');
    await page.click('.aip__chip');
    release();
    await settle();
    await settle();
    expect(
      sent.map((call) => `${call.name} ${String(call.body['body'])}`),
      'one chip question was sent more than once',
    ).toStrictEqual([`conversation.start ${String(chip)}`]);
  });
});
