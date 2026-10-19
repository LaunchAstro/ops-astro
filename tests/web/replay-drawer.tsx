// SPDX-License-Identifier: AGPL-3.0-only
//
// The assistant drawer mounted for the resend suites, and the moves a person
// makes in it, read back as the drawer draws them (`resend-fixture.tsx`).

import type { ReactElement } from 'react';
import { askDrawer, taskAsk } from '../../apps/web/src/assistant/asks.ts';
import type { AskEntry } from '../../apps/web/src/assistant/chats.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { RouteId } from '../../apps/web/src/routes.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';
import { doubleClick, press, track } from '../surfaces/mp-7-11-drawer-fixtures.tsx';

/** The task the stand-in serves: a synthetic brief, no client's. */
export const TASK = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Synthetic brief',
  clientId: null,
};

/** A write's command and the operation id it went under. */
export interface Sent {
  readonly command: string;
  readonly operationId: string;
}

/** A write as it went out: its command and its exact body. */
export interface Body {
  readonly command: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface DrawerAt {
  readonly grantKey?: string;
  readonly route?: RouteId;
  readonly here?: string;
  /** The ask the drawer opens on; a task ask unless told otherwise, none for `null`. */
  readonly ask?: AskEntry | null;
}

/** The drawer element, keyed by its grant as `App.tsx` mounts it. */
export const view = (client: OperationsClient, at: DrawerAt = {}): ReactElement => {
  const grantKey = at.grantKey ?? 'resend-proof';
  return (
    <AssistantView
      key={grantKey}
      grantKey={grantKey}
      client={client}
      route={at.route ?? 'agency:task-detail'}
      here={at.here ?? '/task/T-12'}
      entry={null}
      onClose={() => {}}
    />
  );
};

/** Two settles: one for the press, one for what it set going. */
export async function settled(): Promise<void> {
  await settle();
  await settle();
}

/** A person's moves in a mounted drawer. */
export function movesIn(page: Mounted) {
  const input = '[data-assistant="input"]';
  return {
    page,
    ask: async (...questions: string[]): Promise<void> => {
      for (const question of questions) {
        // oxlint-disable-next-line no-await-in-loop -- one question after another, as typed
        await page.type(input, question);
        // oxlint-disable-next-line no-await-in-loop -- one question after another, as typed
        await press(page, input, 'Enter');
        // oxlint-disable-next-line no-await-in-loop -- one question after another, as typed
        await settled();
      }
    },
    rename: async (key: string, title: string): Promise<void> => {
      await doubleClick(page, `[data-chat="${key}"]`);
      await page.type(`[data-chat-rename="${key}"]`, title);
      await press(page, `[data-chat-rename="${key}"]`, 'Enter');
      await settled();
    },
    model: async (id: string): Promise<void> => {
      await page.choose('[data-assistant="model"]', id);
      await settled();
    },
    addPage: async (): Promise<void> => {
      await page.click('[data-assistant="add-page"]');
      await settled();
    },
    select: async (key: string): Promise<void> => {
      await page.click(`[data-chat="${key}"]`);
      await settled();
    },
    /** Reopens conversation `id` from the history list. */
    reopen: async (id: string): Promise<void> => {
      if (page.find('[data-assistant="past"]') === null) {
        await page.click('[data-assistant="history"]');
        await settled();
      }
      await page.click(`[data-assistant="past"] [data-past="${id}"]`);
      await settled();
    },
  };
}

/** The drawer open on a task (or `at.ask`), and a way to ask in it as a person types. */
export async function drawer(client: OperationsClient, at: DrawerAt = {}) {
  const grantKey = at.grantKey ?? 'resend-proof';
  const entry = at.ask === undefined ? taskAsk(TASK) : at.ask;
  if (entry !== null) askDrawer(entry, grantKey);
  const page = track(await mount(view(client, at)));
  await settle();
  return movesIn(page).ask;
}

/** The drawer, mounted, with every move a person makes in it. */
export async function opened(client: OperationsClient, at: DrawerAt = {}) {
  const grantKey = at.grantKey ?? 'resend-proof';
  const entry = at.ask === undefined ? taskAsk(TASK) : at.ask;
  if (entry !== null) askDrawer(entry, grantKey);
  const page = track(await mount(view(client, at)));
  await settle();
  return movesIn(page);
}

/** The drawer's tabs by key, the selected one, and a tab's lines as role and text. */
export const tabs = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"][data-chat]')].map(
    (tab) => tab.dataset['chat'] ?? '',
  );
export const selectedTab = (): string | undefined =>
  document.querySelector<HTMLElement>('[role="tab"][data-chat][aria-selected="true"]')?.dataset[
    'chat'
  ];
export const lines = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-message-role]')].map(
    (line) => `${line.dataset['messageRole'] ?? ''}: ${line.textContent.trim()}`,
  );
export const tabTitle = (key: string): string =>
  document.querySelector(`[role="tab"][data-chat="${key}"]`)?.textContent.trim() ?? '';
export const pickedModel = (): string | undefined =>
  document.querySelector<HTMLSelectElement>('[data-assistant="model"]')?.value;

export const identities = (sent: readonly Sent[], command: string): string[] =>
  sent.filter((one) => one.command === command).map((one) => one.operationId);

/** The bodies of one command, without their operation ids. */
export const bodiesOf = (bodies: readonly Body[], command: string): Record<string, unknown>[] =>
  bodies
    .filter((one) => one.command === command)
    .map(({ body }) =>
      Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'operationId')),
    );
