// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from 'vitest';
import { realm, copied } from './task-timer-recovery-support.tsx';
import { draftTab, PERSON } from './projects-draft-app-support.tsx';
import { emptyDraft, type TaskDraft } from '../../apps/web/src/screens/task/task-draft.ts';
import { OrderedCreateServer } from './p05-ordered-create-server.ts';
export { copied, draftTab, OrderedCreateServer };
export type Mounted = Awaited<ReturnType<typeof realm>>;
export const CREATE_KEY = 'ops-astro.create-attempts';
export const DRAFT_KEY = `ops-astro.task-draft.${PERSON}`;
export const PARTY = '88888888-1111-4111-8111-111111111111';
export const ASSIGNEE = '77777777-1111-4111-8111-111111111111';
const opened = new Map<Mounted, OrderedCreateServer>();
export function seeded(fields: Partial<TaskDraft> = {}): Storage {
  const storage = draftTab();
  storage.setItem(DRAFT_KEY, JSON.stringify({ ...emptyDraft(null), ...fields }));
  return storage;
}
export async function open(server: OrderedCreateServer, storage = draftTab()): Promise<Mounted> {
  const app = await realm(server.fetch, storage, '/projects/');
  opened.set(app, server);
  return app;
}
export async function drain(app: Mounted): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- let the finite ordered continuation settle
    await app.tick();
  }
}
export async function file(app: Mounted): Promise<void> {
  await app.act(() => {
    const button = app.view.find('[data-projects-new-task]');
    expect(button, 'Actual App toolbar must file the draft').not.toBeNull();
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
  });
  await drain(app);
  expect(app.view.find('[data-draft-panel]')).not.toBeNull();
}
export async function submit(app: Mounted): Promise<void> {
  await app.view.click('[data-draft="create"]');
  await drain(app);
}
export async function retry(app: Mounted, id: string): Promise<void> {
  const selector = `[data-draft-create-retry="${id}"]`;
  expect(
    app.view.find(selector),
    'Original ordered attempt needs an explicit recovery control',
  ).not.toBeNull();
  await app.view.click(selector);
  await drain(app);
}
export function baseId(server: OrderedCreateServer): string {
  const id = server.commands('/task/create')[0]?.body['operationId'];
  if (typeof id !== 'string')
    throw new Error('Actual ordered create omitted its operation identity');
  return id;
}
export async function close(app: Mounted): Promise<void> {
  const server = opened.get(app);
  opened.delete(app);
  await app.view.unmount();
  expect(server?.unexpected ?? []).toStrictEqual([]);
}
export async function closeAll(): Promise<void> {
  for (const app of opened.keys()) {
    // eslint-disable-next-line no-await-in-loop -- each actual React root disposes before the next
    await close(app);
  }
}
export async function reload(server: OrderedCreateServer, app: Mounted): Promise<Mounted> {
  const storage = copied(app.storage);
  await close(app);
  const next = await open(server, storage);
  await file(next);
  return next;
}
export function journal(storage: Storage): Record<string, unknown> {
  const raw = storage.getItem(CREATE_KEY);
  expect(raw, 'Actual App must durably hold the submitted recipe before dispatch').not.toBeNull();
  return JSON.parse(raw!) as Record<string, unknown>;
}
