// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  ASSIGNEE,
  PARTY,
  DRAFT_KEY,
  OrderedCreateServer,
  closeAll,
  file,
  open,
  seeded,
  submit,
} from './p05-draft-create-support.ts';
afterEach(closeAll);
const parentFields = {
  title: 'Receipt cursor task',
  clientId: PARTY,
  category: 'seo',
  owner: { id: ASSIGNEE, name: 'Current assignee' },
  note: 'Original note',
};
it.each([
  {
    name: 'tag',
    fields: { tags: ['New tag'], steps: ['Child'] },
    path: '/task/create',
    occurrence: 2,
  },
  { name: 'child', fields: { steps: ['Child'], time: '10m' }, path: '/time/log', occurrence: 1 },
  {
    name: 'typed time',
    fields: { time: '10m', timedMs: 120_000 },
    path: '/time/log',
    occurrence: 2,
  },
])(
  'canonical $name receipt cannot replace the durable parent revision before a later unknown',
  async ({ fields, path, occurrence }) => {
    const server = new OrderedCreateServer();
    server.lose(path, 'after', occurrence);
    const app = await open(server, seeded({ ...parentFields, ...fields }));
    await file(app);
    await submit(app);
    const stored = JSON.parse(app.storage.getItem(DRAFT_KEY)!) as {
      readonly attempt: { readonly revision: number };
    };
    expect(server.parents[0]?.revision).toBe(4);
    expect(stored.attempt.revision).toBe(4);
  },
);
it.each([
  {
    name: 'note wrong parent',
    path: '/task/comment',
    patch: { recordId: 'aaaaaaaa-1111-4111-8111-111111111111' },
    later: '/tag/create',
  },
  {
    name: 'tag creation non-null revision',
    path: '/tag/create',
    patch: { revision: 1 },
    later: '/task/add_tag',
  },
  {
    name: 'tag add wrong tag',
    path: '/task/add_tag',
    patch: { detail: { tagId: 'bbbbbbbb-1111-4111-8111-111111111111' } },
    later: '/task/create',
  },
  {
    name: 'child missing record identity',
    path: '/task/create',
    patch: { recordId: null },
    later: '/time/log',
  },
  { name: 'time non-null revision', path: '/time/log', patch: { revision: 1 }, later: '/time/log' },
  {
    name: 'time wrong identifier',
    path: '/time/log',
    patch: { detail: { commentId: 'cccccccc-1111-4111-8111-111111111111', minutes: 10 } },
    later: '/time/log',
  },
  {
    name: 'time fractional minutes',
    path: '/time/log',
    patch: { detail: { entryId: 'dddddddd-1111-4111-8111-111111111111', minutes: 1.5 } },
    later: '/time/log',
  },
])(
  'malformed $name success blocks all later creation phases',
  async ({ name, path, patch, later }) => {
    const server = new OrderedCreateServer();
    server.distort = (receipt, request) =>
      request.path === path && (path !== '/task/create' || request.body['parentId'] !== undefined)
        ? { ...receipt, ...patch }
        : receipt;
    const app = await open(
      server,
      seeded({
        ...parentFields,
        tags: ['Typed tag'],
        steps: ['Child'],
        time: '10m',
        timedMs: 120_000,
      }),
    );
    await file(app);
    await submit(app);
    const expected = name === 'tag add wrong tag' ? 1 : name.startsWith('time ') ? 1 : 0;
    expect(server.commands(later)).toHaveLength(expected);
    expect(app.view.find('[data-draft-refusal]')?.textContent).toContain('No answer');
    expect(app.storage.getItem(DRAFT_KEY)).not.toBeNull();
  },
);
