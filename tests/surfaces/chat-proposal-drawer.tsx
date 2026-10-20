// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat proposal card's drawer, mounted over a recording operations client
// that stands in for the network only: each conversation write answers the
// next scripted reply, each task write the next scripted answer, and a kept
// tab's read gives the scripted reply back.

import { askDrawer, taskAsk } from '../../apps/web/src/assistant/asks.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { mount, settle } from './mount.tsx';
import { press } from './mp-7-11-drawer-fixtures.tsx';

export const CONVERSATION = '44444444-4444-4444-8444-444444444444';
export const REPLY = '99999999-9999-4999-8999-999999999999';
export const TASK = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Spring brief',
  clientId: null,
};
export const GRANT = 'alpha:ada';
/** The clicker, and the staff `team.list` gives this business by default. */
export const ADA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TEAM: Answer = {
  ok: true,
  you: ADA,
  people: [{ personId: ADA, name: 'Ada Lovelace', availability: null }],
};

export const block = (json: string): string =>
  `Here is a task for that.\n\n\`\`\`task\n${json}\n\`\`\``;
export const CREATE = block(
  '{"action":"create","title":"Book the printer","description":"Two quotes."}',
);
export const EDIT = block('{"action":"edit","title":"Spring brief, second draft"}');

export type Answer = Readonly<Record<string, unknown>>;

export interface Sent {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly options: Readonly<Record<string, unknown>>;
}

export const answered = (body: string): Answer => ({ answered: true, messageId: REPLY, body });

export const ok = (value: Answer): Answer => ({ ok: true, value });

export const refused = (code: string, fix: string): Answer => ({
  ok: false,
  refused: true,
  code,
  names: [],
  fixes: [fix],
});

export interface Script {
  readonly replies?: readonly Answer[];
  /** Each task write's answer in turn, or one still out; once used up, the write is kept. */
  readonly writes?: readonly (Answer | Promise<Answer>)[];
  /** Each `task.assign`'s answer in turn; once used up, the assignment is kept. */
  readonly assigns?: readonly Answer[];
  /** What `team.list` gives; absent, `TEAM`. */
  readonly team?: Answer;
  /** What `person.list` gives, were it asked. */
  readonly persons?: Answer;
  /** What `conversation.read` gives a kept tab. */
  readonly kept?: {
    readonly body: string;
    readonly scope: Answer | null;
    /** The reply's message id; absent, `REPLY`. */
    readonly messageId?: string;
    /** The reply's targets as the server gives them its owner; absent, none. */
    readonly targets?: unknown;
    /** The bound pages the read gives (#1988); absent, none. */
    readonly sitePages?: unknown;
  };
  /** What `task.read` gives for each task id named here; any other, `TASK` at `revision`. */
  readonly tasks?: Readonly<Record<string, Answer>>;
  /** The task's revision as `task.read` gives it now. */
  readonly revision?: () => number;
}

/** `conversation.read` of the kept tab: the person's question, then the reply. */
const keptRead = (kept: NonNullable<Script['kept']>): Answer =>
  ok({
    ok: true,
    conversation: {
      id: CONVERSATION,
      address: `/agent/${CONVERSATION}`,
      title: 'Kept chat',
      subject: null,
      scope: kept.scope,
      page: null,
      createdAt: '2026-10-12T00:00:00Z',
      lastActivityAt: '2026-10-12T00:00:00Z',
      bodyPurgedAt: null,
    },
    messages: [
      { id: 'q-1', role: 'person', body: 'Set it up', createdAt: '2026-10-12T00:00:00Z' },
      {
        id: kept.messageId ?? REPLY,
        role: 'agent',
        body: kept.body,
        createdAt: '2026-10-12T00:00:01Z',
        ...(kept.targets === undefined ? {} : { targets: kept.targets }),
      },
    ],
    wrapUp: null,
    wrapUpHistory: [],
    ...(kept.sitePages === undefined ? {} : { sitePages: kept.sitePages }),
  });

// eslint-disable-next-line max-lines-per-function -- one stand-in client, each read and write it answers
function recorder(script: Script) {
  const sent: Sent[] = [];
  const reads: { readonly name: string; readonly body: Answer }[] = [];
  /** Every call's name, reads and writes, in the order they left. */
  const order: string[] = [];
  const replies = [...(script.replies ?? [])];
  const writes = [...(script.writes ?? [])];
  const assigns = [...(script.assigns ?? [])];
  const client = {
    newOperationId: () => 'op-fresh-1',
    read: (name: string, body: Answer) => {
      reads.push({ name, body });
      order.push(name);
      const named = script.tasks?.[String(body['recordId'])];
      if (name === 'task.read' && named !== undefined) return Promise.resolve(named);
      if (name === 'task.read') {
        const revision = script.revision?.() ?? 7;
        return Promise.resolve(
          ok({ ok: true, task: { id: TASK.id, key: 'T-12', title: TASK.title, revision } }),
        );
      }
      if (name === 'team.list') return Promise.resolve(script.team ?? ok(TEAM));
      if (name === 'person.list' && script.persons !== undefined) {
        return Promise.resolve(script.persons);
      }
      if (name === 'conversation.read' && script.kept !== undefined) {
        return Promise.resolve(keptRead(script.kept));
      }
      return Promise.resolve({ unavailable: true, because: 'not asked here' });
    },
    mutate: (name: string, body: Answer, options: Answer = {}) => {
      sent.push({ name, body, options });
      order.push(name);
      if (name === 'task.assign') {
        return Promise.resolve(assigns.shift() ?? ok({ recordId: 'new-task-id', revision: 2 }));
      }
      if (name === 'task.create' || name === 'task.update') {
        return Promise.resolve(
          writes.shift() ??
            ok({ recordId: 'new-task-id', revision: 1, detail: { key: 'T-31', source: 'person' } }),
        );
      }
      const reply = replies.shift();
      return Promise.resolve(
        ok({
          recordId: '',
          revision: 0,
          detail: { conversationId: CONVERSATION },
          ...(reply === undefined ? {} : { reply }),
        }),
      );
    },
  } as unknown as OperationsClient;
  return { client, sent, reads, order };
}

export async function drawer(script: Script, onTask = false) {
  const { client, sent, reads, order } = recorder(script);
  if (onTask) askDrawer(taskAsk(TASK), GRANT);
  const page = await mount(
    <AssistantView
      grantKey={GRANT}
      client={client}
      route={onTask ? 'agency:task-detail' : 'agency:projects-board'}
      here={onTask ? '/task/T-12' : '/projects'}
      entry={null}
      onClose={() => {}}
    />,
  );
  await settle();
  const ask = async (text: string): Promise<void> => {
    await page.type('[data-assistant="input"]', text);
    await press(page, '[data-assistant="input"]', 'Enter');
    await settle();
  };
  const click = async (): Promise<void> => {
    await page.click('[data-proposal="send"]');
    await settle();
  };
  const writes = (): readonly Sent[] =>
    sent.filter((each) => each.name === 'task.create' || each.name === 'task.update');
  const assigned = (): readonly Sent[] => sent.filter((each) => each.name === 'task.assign');
  return { page, sent, reads, order, ask, click, writes, assigned };
}
