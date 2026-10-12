// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C71 team chat, the web half (CS-7.25, CS-7.26, CS-7.41, CS-7.42): the Team
// screen feeds the kit's TeamPanel from the two chat reads and sends through
// the chat commands, with no Mock label on those real paths. A conversation's
// own topic, `conversation:<uuid>`, re-reads its messages; the board topic
// re-reads the reader's conversations, and with them the Team tab's unread
// chip. A refused send shows the API's own refusal. The server is a stand-in
// whose stream the case writes into; the server half (the topic, its member
// check, the board's conversation signal) is proven in tests/api.

import { act, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useTeamUnread } from '../../apps/web/src/data/dock-counts.ts';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import type { Session } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from './mount.tsx';
import { DIRECT, GROUP, said, server } from './team-chat-stand-in.ts';

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  });
};

async function until(say: string, check: () => boolean, deadline = Date.now() + 2000) {
  if (check()) return;
  if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
  await settle();
  await until(say, check, deadline);
}

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const shown = (m: Mounted): string[] =>
  m.all('.tmc__conv .msg').map((el) => (el as HTMLElement).dataset['message'] ?? '');

async function team() {
  const api = server();
  view = await mount(<TeamScreen client={api.client} grantKey="alpha:ana" />);
  const m = view;
  await until('the conversation open on Bo', () => shown(m).length > 0);
  return { api, m };
}

async function sendWords(m: Mounted, words: string): Promise<void> {
  await m.type('.tmc__conv .composer input', words);
  await act(() => {
    m.host
      .querySelector('.tmc__conv form.composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** A command as sent, its fresh operation id checked and set aside. */
const strip = ({ at, body }: { at: string; body: Record<string, unknown> }) => {
  const { operationId, ...rest } = body;
  expect(typeof operationId).toBe('string');
  return { at, ...rest };
};

describe('C71 web (1) the Team panel shows the real conversations, with no mock label', () => {
  it('feeds TeamPanel from chat.conversations and chat.messages and opens on the first unread', async () => {
    const { api, m } = await team();
    expect(shown(m)).toEqual(['m1', 'm2']);
    expect(m.find('[data-person="p-bo"] .cbadge')?.textContent).toBe('1');
    expect(m.find(`[data-group="${GROUP}"]`)?.textContent).toBe('Shoot crew');
    expect(api.reads).toContain('conversations');
    expect(api.reads).toContain(`messages ${DIRECT}`);
    expect(api.reads).toContain(`messages ${GROUP}`);
    expect(m.find('[data-provenance="mock"]')).toBeNull();
    expect(m.find('.mocktag')).toBeNull();
  });

  it('sends and reads through chat.send_direct, chat.mark_read and chat.send_group', async () => {
    const { api, m } = await team();
    await m.click('.tmc__conv .tmc__scroll');
    await sendWords(m, 'On my way');
    await m.click(`[data-group="${GROUP}"]`);
    await sendWords(m, 'Shoot at 2');
    await until('four commands', () => api.sent.length === 4);
    expect(api.sent.map(strip)).toEqual([
      { at: '/chat/mark_read', conversationId: DIRECT, upTo: '2026-10-01T10:00:00.000Z' },
      { at: '/chat/send_direct', teammateId: 'p-bo', body: 'On my way' },
      { at: '/chat/mark_read', conversationId: GROUP, upTo: '2026-10-01T07:00:00.000Z' },
      { at: '/chat/send_group', conversationId: GROUP, body: 'Shoot at 2' },
    ]);
  });
});

describe('C71 web (2) the open thread moves on its own topic', () => {
  it('re-reads chat.messages when the stream signals conversation:<uuid>', async () => {
    const { api, m } = await team();
    await until('the conversation topic joined', () =>
      (api.joins.at(-1) ?? '').includes(`topic=conversation%3A${DIRECT}`),
    );
    await settle();
    const before = api.reads.length;
    api.chats[DIRECT]?.messages.push(said('m3', 'p-bo', '2026-10-01T11:00:00.000Z'));
    api.send('invalidate', `conversation:${DIRECT}`);
    await until('the new message drawn', () => shown(m).includes('m3'));
    expect(api.reads.slice(before)).toEqual([`messages ${DIRECT}`]);
  });
});

describe("C71 web (3) the Team tab's unread chip moves on the board stream", () => {
  it('paints at load from chat.conversations and re-reads it when the board topic signals', async () => {
    const api = server();
    const session: Session = { businessKey: 'alpha', email: 'ana@example.test' };
    function Chip(): ReactElement {
      const unread = useTeamUnread(api.client, session, true);
      return <b data-chip>{unread === null ? 'none' : String(unread)}</b>;
    }
    view = await mount(<Chip />);
    const m = view;
    const chip = (): string | undefined => m.find('[data-chip]')?.textContent ?? undefined;
    await until('the chip painted', () => chip() === '2');
    await until('the board joined', () => (api.joins.at(-1) ?? '').includes('topic=board'));
    const chat = api.chats[DIRECT];
    if (chat !== undefined) chat.view = { ...chat.view, unread: 4 };
    api.send('resync', 'board');
    await until('the chip moved', () => chip() === '5');
    expect(api.reads.filter((read) => read === 'conversations')).toHaveLength(2);
  });
});

describe('C71 web (4) a refused send shows the API’s own refusal', () => {
  it('draws the refusal text the API answered', async () => {
    const { api, m } = await team();
    api.state.refuse = {
      refused: true,
      code: 'FIELD_VALUE_INVALID',
      names: ['body'],
      fixes: ['Write the message before sending it.'],
    };
    await sendWords(m, 'x');
    await until('the refusal drawn', () => m.find('[role="alert"]') !== null);
    expect(m.find('[role="alert"]')?.textContent).toBe(
      'FIELD_VALUE_INVALID (body). Write the message before sending it.',
    );
  });
});
