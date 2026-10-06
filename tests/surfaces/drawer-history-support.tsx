// SPDX-License-Identifier: AGPL-3.0-only
//
// The drawer history cases' stand-in client and helpers (MP-7-11 CS-7.33, C36):
// the server's conversations as each case leaves them, every read and write
// kept, and `conversation.read` held behind a gate when a case races it.

import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';
import { track } from './mp-7-11-drawer-fixtures.tsx';

export const ONE = '11111111-1111-4111-8111-111111111111';
export const TWO = '22222222-2222-4222-8222-222222222222';
export const MADE = '33333333-3333-4333-8333-333333333333';

export interface Call {
  readonly kind: 'read' | 'write';
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export const message = (id: string, role: 'person' | 'agent', body: string) => ({
  id,
  role,
  body,
  createdAt: '2026-10-06T10:00:00.000Z',
});

const NOT_FOUND = { refused: true, code: 'NOT_FOUND', names: [], fixes: [] };

/** The server's conversations: their titles and stored messages, read as the case left them. */
export type Stored = Record<string, { title: string; messages: ReturnType<typeof message>[] }>;

const AT = '2026-10-06T10:00:00.000Z';

const listOf = (stored: Stored) => ({
  ok: true,
  value: {
    ok: true,
    conversations: Object.entries(stored).map(([id, one]) => ({
      id,
      address: `/agent/${id}`,
      title: one.title,
      lastActivityAt: AT,
      bodyPurged: false,
    })),
  },
});

function readOf(stored: Stored, id: string) {
  const one = stored[id];
  if (one === undefined) return NOT_FOUND;
  const conversation = {
    id,
    address: `/agent/${id}`,
    title: one.title,
    subject: null,
    scope: null,
    page: null,
    createdAt: AT,
    lastActivityAt: AT,
    bodyPurgedAt: null,
  };
  return { ok: true, value: { ok: true, conversation, messages: one.messages, wrapUp: null } };
}

/** A stand-in client over `stored`, keeping every call; `conversation.read` answers once `gate` opens. */
export function serving(
  stored: Stored,
  mutate?: (call: Omit<Call, 'kind'>) => Promise<unknown>,
  gate: Promise<void> = Promise.resolve(),
) {
  const calls: Call[] = [];
  const read = async (name: string, body: Readonly<Record<string, unknown>>) => {
    calls.push({ kind: 'read', name, body });
    if (name === 'conversation.list') return listOf(stored);
    await gate;
    return name === 'conversation.read'
      ? readOf(stored, String(body['conversationId']))
      : NOT_FOUND;
  };
  const client = {
    read,
    mutate: (name: string, body: Readonly<Record<string, unknown>>) => {
      calls.push({ kind: 'write', name, body });
      return mutate === undefined
        ? Promise.resolve({ unavailable: true, because: 'n/a' })
        : mutate({ name, body });
    },
  } as unknown as OperationsClient;
  return { client, calls };
}

export async function drawerFor(
  client: OperationsClient,
  grantKey = 'alpha:ana',
): Promise<Mounted> {
  const page = track(
    await mount(
      <AssistantView
        client={client}
        route="agency:settings"
        here="/settings"
        entry={null}
        grantKey={grantKey}
      />,
    ),
  );
  await settle();
  return page;
}

export const tabTitles = (page: Mounted): (string | null)[] =>
  page.all('[data-chat]').map((tab) => tab.textContent);

export const bodies = (page: Mounted): (string | null)[] =>
  (page.all('[data-message-role]') as HTMLElement[]).map(
    (line) => `${line.dataset['messageRole']}: ${line.textContent}`,
  );

export const STORED: Stored = {
  [ONE]: {
    title: 'Pacing question',
    messages: [
      message('m1', 'person', 'Is pacing on track?'),
      message('m2', 'agent', 'Yes, 4% under.'),
    ],
  },
  [TWO]: { title: 'Older chat', messages: [message('m3', 'person', 'Hello')] },
};
