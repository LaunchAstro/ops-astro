// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// Actual App recovery and closed-journal hydration controls.
import { afterEach, expect, it } from 'vitest';
import {
  close,
  closeAll,
  copied,
  createSlot,
  CreateServer,
  draftTab,
  inline,
  open,
  operationOf,
  retry,
} from './p05-inline-create-support.ts';
afterEach(closeAll);
function journalEntry(value: unknown, id: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Actual create journal was not an object');
  const document = value as Record<string, unknown>;
  if (
    typeof document['entries'] !== 'object' ||
    document['entries'] === null ||
    Array.isArray(document['entries'])
  )
    throw new Error('Actual create journal had no closed entry collection');
  const entries = document['entries'] as Record<string, Record<string, unknown>>;
  const entry = entries[id];
  if (entry === undefined) throw new Error('Submitted entry missing');
  return { document, entry };
}
function corruptCopy(value: unknown, id: string, corruption: string): string {
  const { document, entry } = journalEntry(value, id);
  switch (corruption) {
    case 'truncated':
      return '{';
    case 'array':
      return JSON.stringify([]);
    case 'foreign-owner':
      return JSON.stringify({ ...document, owner: 'bravo:foreign:0' });
    case 'extra-field':
      return JSON.stringify({
        ...document,
        entries: { [id]: { ...entry, arbitraryCommand: 'task.complete' } },
      });
    case 'derived-id':
      return JSON.stringify({
        ...document,
        entries: { [`${id}.0`]: { ...entry, operationId: `${id}.0` } },
      });
    case 'impossible-receipt':
      return JSON.stringify({
        ...document,
        entries: {
          [id]: {
            ...entry,
            knowledge: { kind: 'answered', receipt: { recordId: 'not-a-uuid', revision: -1 } },
          },
        },
      });
  }
  throw new Error(`Unexpected corruption ${corruption}`);
}

it.each([
  'truncated',
  'array',
  'foreign-owner',
  'extra-field',
  'derived-id',
  'impossible-receipt',
] as const)(
  'hydration withholds %s custody and never reconstructs or sends it',
  async (corruption) => {
    const server = new CreateServer();
    server.lose('/task/create', 'after');
    const app = await open(server);
    await inline(app, 'Held malformed copy');
    const id = operationOf(server);
    const { key, value } = createSlot(app.storage);
    const raw = corruptCopy(value, id, corruption);
    const tab = copied(app.storage);
    tab.setItem(key, raw);
    await close(app);
    const next = await open(server, tab);
    expect(server.commands('/task/create')).toHaveLength(1);
    expect(next.view.find(`[data-create-retry="${id}"]`)).toBeNull();
    expect(next.view.text()).toContain('could not be recovered');
    await inline(next, 'New task cannot overwrite uncertain bytes');
    expect(server.commands('/task/create')).toHaveLength(1);
    expect(tab.getItem(key)).toBe(raw);
    expect(server.tasks).toHaveLength(1);
    expect(server.applied).toHaveLength(1);
  },
);

it('failed persistence readback sends nothing and leaves the prepared create actionable', async () => {
  const server = new CreateServer();
  const tab = draftTab();
  const read = tab.getItem.bind(tab);
  let corrupt = true;
  tab.getItem = (key) => {
    const kept = read(key);
    return key === 'ops-astro.create-attempts' && kept !== null && corrupt ? '{' : kept;
  };
  const app = await open(server, tab);
  await inline(app, 'Readback blocked');
  expect(server.commands('/task/create')).toHaveLength(0);
  expect(app.view.text()).toContain('No new task was sent');
  expect(app.view.text()).not.toContain('may already have been created');
  corrupt = false;
  await app.view.click('.projects__create button[type="submit"]');
  await app.tick();
  expect(server.commands('/task/create')).toHaveLength(1);
  expect(server.applied).toHaveLength(1);
});

it('failure to persist a second entry preserves the original unresolved entry', async () => {
  const server = new CreateServer();
  server.lose('/task/create', 'after');
  const app = await open(server);
  await inline(app, 'First retained entry');
  const original = createSlot(app.storage);
  const first = server.commands('/task/create')[0]!;
  const write = app.storage.setItem.bind(app.storage);
  app.storage.setItem = (key, value) => {
    if (key === original.key && value.includes('Second blocked entry'))
      throw new Error('quota denied');
    write(key, value);
  };
  await inline(app, 'Second blocked entry');
  expect(server.commands('/task/create')).toHaveLength(1);
  expect(createSlot(app.storage).value).toStrictEqual(original.value);
  await retry(app, operationOf(server));
  expect(server.commands('/task/create')[1]).toStrictEqual(first);
  expect(server.applied).toHaveLength(1);
});

it('a same-owner new transport retires a held answer and explicit retry retains the full request', async () => {
  const server = new CreateServer();
  const release = server.hold('/task/create');
  const app = await open(server);
  await inline(app, 'Epoch held title');
  const sent = server.commands('/task/create')[0]!;
  await app.renderFetch((url, init) => server.fetch(url, init));
  await app.tick();
  await app.view.type('#create-title', 'Next transport editor');
  await app.act(() => {
    release();
  });
  await app.tick();
  expect(app.view.find('#create-title')).toHaveProperty('value', 'Next transport editor');
  expect(app.view.find(`[data-create-retry="${operationOf(server)}"]`)).not.toBeNull();
  await retry(app, operationOf(server));
  expect(server.commands('/task/create')[1]).toStrictEqual(sent);
  expect(server.applied).toHaveLength(1);
});

it('withholds an impossible persisted prepared phase without replay or false cleanup on denial', async () => {
  const server = new CreateServer();
  server.lose('/task/create', 'after');
  const app = await open(server);
  await inline(app, 'Possibly applied before corrupted phase');
  const id = operationOf(server);
  const { key, value } = createSlot(app.storage);
  const { document, entry } = journalEntry(value, id);
  const raw = JSON.stringify({
    ...document,
    entries: { [id]: { ...entry, knowledge: { kind: 'prepared' } } },
  });
  const tab = copied(app.storage);
  tab.setItem(key, raw);
  await close(app);
  server.denied = true;
  const next = await open(server, tab);
  if (next.view.find(`[data-create-retry="${id}"]`) !== null) await retry(next, id);
  expect(server.commands('/task/create'), `Captured possibly-applied journal: ${raw}`).toHaveLength(
    1,
  );
  expect(next.view.find(`[data-create-retry="${id}"]`)).toBeNull();
  expect(next.view.text()).toContain('could not be recovered');
  expect(next.view.find('[data-create-cleanup]')).toBeNull();
  expect(tab.getItem(key)).toBe(raw);
  await inline(next, 'New create cannot replace a possibly applied copy');
  expect(server.commands('/task/create')).toHaveLength(1);
  expect(tab.getItem(key)).toBe(raw);
  expect(server.tasks).toHaveLength(1);
  expect(server.applied).toHaveLength(1);
});
