// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  DRAFT_KEY,
  OrderedCreateServer,
  close,
  closeAll,
  file,
  open,
  reload,
  seeded,
  submit,
} from './p05-draft-create-support.ts';
afterEach(closeAll);

it.each(['business', 'person', 'signout'] as const)(
  '%s departure retires a newly kept current draft through an A-to-B-to-A return when removal is refused',
  async (departure) => {
    const server = new OrderedCreateServer();
    server.lose('/task/comment', 'after');
    const app = await open(server, seeded({ note: 'Prior owner private note' }));
    await file(app);
    await app.view.type('#panel-draft-name', 'Prior owner pending draft');
    await submit(app);
    expect(server.parents).toHaveLength(1);
    expect(server.commands('/task/comment')).toHaveLength(1);
    const raw = app.storage.getItem(DRAFT_KEY);
    expect(raw).not.toBeNull();
    expect(raw).toContain('Prior owner private note');
    const remove = app.storage.removeItem.bind(app.storage);
    const removals: string[] = [];
    app.storage.removeItem = (key) => {
      removals.push(key);
      if (key === DRAFT_KEY) throw new Error('owner cleanup refused');
      remove(key);
    };
    if (departure === 'signout') app.sessions.clear();
    else
      app.sessions.set({
        businessKey: departure === 'business' ? 'bravo' : 'alpha',
        email: departure === 'person' ? 'other@example.test' : 'draft-entry@example.test',
      });
    await close(app);
    server.person(departure === 'person' ? 'other@example.test' : 'draft-entry@example.test');
    const away = await open(server, app.storage);
    expect(away.view.find('[data-draft-panel]')).toBeNull();
    expect(removals).toContain(DRAFT_KEY);
    expect(away.storage.getItem(DRAFT_KEY)).toBe(raw);
    away.sessions.set({ businessKey: 'alpha', email: 'draft-entry@example.test' });
    server.person('draft-entry@example.test');
    const next = await reload(server, away);
    expect(next.view.find('#panel-draft-name')).toHaveProperty('value', '');
    expect(next.view.find('#panel-draft-note')).toHaveProperty('value', '');
    expect(next.view.find('[data-draft-panel]')?.textContent).not.toContain(
      'Prior owner private note',
    );
    expect(next.view.find('[data-draft-panel]')?.textContent).not.toContain(
      'Prior owner pending draft',
    );
    expect(server.parents).toHaveLength(1);
    expect(server.commands('/task/comment')).toHaveLength(1);
    expect(server.writes()).toHaveLength(2);
  },
);
