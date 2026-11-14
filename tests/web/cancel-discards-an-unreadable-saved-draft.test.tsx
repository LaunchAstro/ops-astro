// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #1461: Cancel promises to discard the draft. A saved copy the panel cannot
// read is held through edits and Create (nothing is sent from it), but Cancel,
// the person's own act, removes it, so the next New task starts clean.
import { afterEach, expect, it, vi } from 'vitest';
import {
  DRAFT_KEY,
  OrderedCreateServer,
  closeAll,
  file,
  open,
  seeded,
  submit,
} from './p05-draft-create-support.ts';
import { typeInto } from './perspective-support.tsx';

afterEach(async () => {
  await closeAll();
  vi.restoreAllMocks();
});

it('Cancel discards an unreadable saved draft, and New task then creates', async () => {
  const server = new OrderedCreateServer();
  const storage = seeded({ title: 'Unsent words' });
  const raw = JSON.stringify({
    ...(JSON.parse(storage.getItem(DRAFT_KEY)!) as object),
    title: null,
  });
  storage.setItem(DRAFT_KEY, raw);
  const app = await open(server, storage);

  await file(app);
  await typeInto(app.view, '#panel-draft-name', 'A valid title');
  await submit(app);
  expect(server.writes(), 'Create refuses the unreadable copy').toHaveLength(0);
  expect(storage.getItem(DRAFT_KEY)).toBe(raw);

  await app.view.click('[data-draft="cancel"]');
  expect(app.view.find('[data-draft-panel]'), 'Cancel closes the panel').toBeNull();
  expect(storage.getItem(DRAFT_KEY), 'Cancel discards the unreadable copy').toBeNull();

  await file(app);
  await typeInto(app.view, '#panel-draft-name', 'A fresh task');
  await submit(app);
  const created = server.commands('/task/create');
  expect(created, 'New task creates once the copy is gone').toHaveLength(1);
  expect(JSON.stringify(created[0]?.body)).toContain('A fresh task');
});
