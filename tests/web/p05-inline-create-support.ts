// SPDX-License-Identifier: AGPL-3.0-only
// Requires the admitted F+C+D composition. No new product controller is imported.
import { expect } from 'vitest';
import { realm, copied } from './task-timer-recovery-support.tsx';
import { draftTab } from './projects-draft-app-support.tsx';
import { CreateServer } from './p05-inline-create-server.ts';
export { copied, CreateServer, draftTab };
export type Mounted = Awaited<ReturnType<typeof realm>>;
const opened = new Map<Mounted, CreateServer>();
export async function open(server: CreateServer, storage = draftTab()): Promise<Mounted> {
  const app = await realm(server.fetch, storage, '/projects/');
  opened.set(app, server);
  return app;
}
export async function close(app: Mounted): Promise<void> {
  const server = opened.get(app);
  opened.delete(app);
  await app.view.unmount();
  expect(server?.unexpected ?? []).toStrictEqual([]);
}
export async function closeAll(): Promise<void> {
  for (const app of opened.keys()) {
    // eslint-disable-next-line no-await-in-loop -- each React root cleanup finishes before the next
    await close(app);
  }
  opened.clear();
}
export async function inline(app: Mounted, title: string): Promise<void> {
  await app.view.type('#create-title', title);
  await app.view.click('.projects__create button[type="submit"]');
  await app.tick();
}
/** Proposed minimal explicit recovery action; final markup is root-owned. */
export async function retry(app: Mounted, operationId: string): Promise<void> {
  const selector = `[data-create-retry="${operationId}"]`;
  expect(app.view.find(selector), 'The actual caller must offer the held attempt').not.toBeNull();
  await app.view.click(selector);
  await app.tick();
}

export function operationOf(server: CreateServer, index = 0): string {
  const id = server.commands('/task/create')[index]?.body['operationId'];
  if (typeof id !== 'string') throw new Error('Actual create request has no operation identity');
  return id;
}
export function createSlot(storage: Storage): { readonly key: string; readonly value: unknown } {
  const key = 'ops-astro.create-attempts';
  const raw = storage.getItem(key);
  if (raw === null) throw new Error('Actual App did not persist its create journal');
  return { key, value: JSON.parse(raw) as unknown };
}
