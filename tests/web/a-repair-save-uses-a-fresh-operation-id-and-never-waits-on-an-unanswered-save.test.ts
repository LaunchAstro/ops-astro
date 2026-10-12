// SPDX-License-Identifier: AGPL-3.0-only
//
// One person's newest preference wins across their sign-ins. When an older
// client's save answers after the newest one already has, the newest value is
// sent again through the newest client as a new intent, with its own
// operation id. Nothing waits on a save that has not answered.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { savePreference } from '../../apps/web/src/data/preference-saves.ts';
import { nextRequest, type Tag } from '../../apps/web/src/data/owned.ts';
import { tabOwnerGeneration } from '../../apps/web/src/session/token.ts';

interface Save {
  readonly client: string;
  readonly value: unknown;
  readonly operationId: string;
}

const saved = (): Response => Response.json({ recordId: null, revision: null, detail: {} });

function clients() {
  const saves: Save[] = [];
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- replaced by the resolver below
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = (name: string, hold: (value: unknown) => Promise<void> | null) =>
    new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: async (_, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        saves.push({
          client: name,
          value: body['value'],
          operationId: String(body['operationId']),
        });
        await hold(body['value']);
        return saved();
      },
    });
  return { saves, gate, release, client };
}

const tag = (person: string): Tag => ({
  business: 'alpha',
  person,
  request: nextRequest(),
  tab: tabOwnerGeneration(),
});

const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

it('an older save answering after the newest sends the newest again with a fresh operation id', async () => {
  const world = clients();
  const older = world.client('older', (value) => (value === 'dark' ? world.gate : null));
  const newer = world.client('newer', () => null);
  const dark = savePreference(older, 'appearance', 'dark', tag('alpha:ada:repair'));
  await settled();
  await savePreference(newer, 'appearance', 'light', tag('alpha:ada:repair'));
  world.release();
  await dark;
  await settled();
  expect(world.saves.map(({ client, value }) => [client, value])).toEqual([
    ['older', 'dark'],
    ['newer', 'light'],
    ['newer', 'light'],
  ]);
  const [, newest, repair] = world.saves;
  expect(repair!.operationId).not.toBe(newest!.operationId);
});

it('a new sign-in saves at once while an older save never answers', async () => {
  const world = clients();
  const hung = world.client('older', () => new Promise<void>(() => {}));
  const newer = world.client('newer', () => null);
  void savePreference(hung, 'appearance', 'dark', tag('alpha:ada:hung'));
  await settled();
  const result = await savePreference(newer, 'appearance', 'light', tag('alpha:ada:hung'));
  expect(result).toMatchObject({ ok: true });
  expect(world.saves.map(({ client, value }) => [client, value])).toEqual([
    ['older', 'dark'],
    ['newer', 'light'],
  ]);
});
