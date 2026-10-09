// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  DRAFT_KEY,
  OrderedCreateServer,
  close,
  closeAll,
  copied,
  file,
  open,
  seeded,
  submit,
} from './p05-draft-create-support.ts';
afterEach(closeAll);

it('invalid recovery operands retain an already applied unknown create identity', async () => {
  const server = new OrderedCreateServer();
  server.lose('/task/create', 'after');
  const app = await open(server, seeded({ title: 'Already applied original task' }));
  await file(app);
  await submit(app);
  expect(server.applied).toHaveLength(1);
  const originalWrite = server.writes()[0]!;
  const tab = copied(app.storage);
  const captured = JSON.parse(tab.getItem(DRAFT_KEY)!) as Record<string, unknown>;
  const attempt = captured['attempt'];
  expect(attempt).not.toBeUndefined();
  const raw = JSON.stringify({ ...captured, clientId: 'invalid-client-identity' });
  tab.setItem(DRAFT_KEY, raw);
  await close(app);
  const next = await open(server, tab);
  await file(next);
  expect(server.writes()).toStrictEqual([originalWrite]);
  expect(tab.getItem(DRAFT_KEY)).toBe(raw);
  await submit(next);
  expect(server.writes()).toStrictEqual([originalWrite]);
  expect(server.applied).toHaveLength(1);
  expect(JSON.parse(tab.getItem(DRAFT_KEY)!)['attempt']).toStrictEqual(attempt);
  expect(tab.getItem(DRAFT_KEY)).toBe(raw);
  const notice = next.view.find('[data-draft-refusal]')?.textContent;
  expect(notice).toContain('No recovery request was sent');
  expect(notice).toContain('The original create may already have applied');
  expect(notice).not.toContain('No creation request was sent');
});

it('a fresh invalid draft remains a local refusal with no writes or effects', async () => {
  const server = new OrderedCreateServer();
  const app = await open(
    server,
    seeded({ title: 'Unsent task', clientId: 'invalid-client-identity' }),
  );
  await file(app);
  await submit(app);
  expect(server.writes()).toHaveLength(0);
  expect(server.applied).toHaveLength(0);
  expect(app.view.find('[data-draft-refusal]')?.textContent).toContain(
    'No creation request was sent',
  );
});
