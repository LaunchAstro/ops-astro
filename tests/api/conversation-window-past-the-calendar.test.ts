// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation window longer than the calendar reaches back. The settings
// commands accept any whole number of days, so a business can set one; a
// wrapped body under it, its work closed, is simply not due, from the purge
// and from the sweep alike, and neither faults on date arithmetic.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  purgeConversation,
  sweepConversations,
  writeWrapUp,
} from '../../packages/core-commands/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  CODE_REVISION,
  conversationWorld,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** Past the calendar's start, then the longest the settings commands accept. */
const LONG_WINDOWS = [3_000_000, Number.MAX_SAFE_INTEGER];

// eslint-disable-next-line max-lines-per-function -- one world, one case per window
describe.skipIf(serverUrl === undefined)('a conversation window past the calendar', () => {
  let w: ConversationWorld;
  let conversationId: string;

  const messages = async (): Promise<number> =>
    await w.count(
      `select count(*) as n from public.conversation_messages where conversation_id = $1`,
      [conversationId],
    );

  /** Both windows set through their own commands, the retention window first as they grow. */
  const windows = async (days: number): Promise<void> => {
    for (const command of ['settings.set_retention_window', 'settings.set_conversation_window']) {
      // oxlint-disable-next-line no-await-in-loop -- the order is the ceiling's
      const outcome = await executeCommand(
        w.fixture.db.app,
        w.fixture.business,
        w.owner.presented,
        'api',
        { command, operationId: randomUUID(), value: days } as never,
      );
      expect(isCommandRefusal(outcome) ? outcome.code : 'applied', command).toBe('applied');
    }
  };

  beforeAll(async () => {
    w = await conversationWorld('longwin');
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, w.owner, 'manage', WHOLE_BUSINESS, false, 'settings');
    });
    const created = await w.as(w.owner, 'task.create', { fields: { title: 'closed work' } });
    const taskId = (created.body as { recordId: string }).recordId;
    conversationId = await started(w, w.owner, {
      scope: { kind: 'task', id: taskId },
      body: 'About work that is done.',
    });
    const task = await w.as(w.owner, 'task.read', { recordId: taskId });
    const done = await w.as(w.owner, 'task.complete', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: (task.body['task'] as { revision: number }).revision,
    });
    expect(done.status).toBe(200);
    await w.age(conversationId, 10);
    const wrapped = await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: CODE_REVISION }),
    );
    expect(wrapped).toMatchObject({ ok: true, written: true });
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  it.each(LONG_WINDOWS)('a window of %d days keeps the body as not due', async (days) => {
    await windows(days);
    const purge = await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await purgeConversation(tx, { conversationId, operationId: randomUUID() }),
    );
    expect(purge).toEqual({ ok: false, code: 'NOT_DUE' });
    expect(await messages()).toBe(1);

    const report = await sweepConversations(w.fixture.db.app, {
      businessId: w.fixture.business,
      codeRevision: CODE_REVISION,
    });
    expect(report).toMatchObject({ purged: [], failed: [], windowUnreadable: false });
    expect(report.held).toContainEqual({ conversationId, code: 'NOT_DUE' });
    expect(await messages()).toBe(1);
  });
});
