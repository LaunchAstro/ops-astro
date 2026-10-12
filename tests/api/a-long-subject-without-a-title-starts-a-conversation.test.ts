// SPDX-License-Identifier: AGPL-3.0-only
//
// `conversation.start` accepts a subject of up to 200 characters and no title,
// and then titles the conversation from its subject. A title holds at most 120
// characters (0092 `conversations_title_bounded`), so a longer subject is cut
// to a title that fits, by whole characters, and the conversation opens.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a long subject without a title', () => {
  let w: ConversationWorld;
  beforeAll(async () => {
    w = await conversationWorld('start_long_subject');
  }, 180_000);
  afterAll(async () => {
    await w?.drop();
  });

  /** The kept title of the conversation `subject` opened, or the start's status when none opened. */
  async function titleFrom(subject: string): Promise<string | number> {
    const answer = await w.as(w.owner, 'conversation.start', { body: 'Hello', subject });
    const id = answer.status === 200 ? detail(answer)['conversationId'] : undefined;
    if (typeof id !== 'string') return answer.status;
    const [row] = await w.fixture.db.admin.execute<{ title: string }>(
      'select title from public.conversations where id = $1',
      [id],
    );
    return row?.title ?? answer.status;
  }

  it('opens with a title cut from a 121-character subject', async () => {
    const title = await titleFrom('S'.repeat(121));
    expect(title).toBe(`${'S'.repeat(119)}…`);
  });

  it('opens with a title cut from a 200-character subject, never half a character', async () => {
    const title = await titleFrom(`${'a'.repeat(118)}😀${'b'.repeat(80)}`);
    // The emoji's pair would end past the limit, so it is left out whole.
    expect(title).toBe(`${'a'.repeat(118)}…`);
  });

  it('keeps a subject that fits as its title, whole', async () => {
    expect(await titleFrom('S'.repeat(120))).toBe('S'.repeat(120));
  });
});
