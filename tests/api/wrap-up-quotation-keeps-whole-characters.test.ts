// SPDX-License-Identifier: AGPL-3.0-only
//
// A wrap-up's request is the first message as a quotation, cut short with an
// ellipsis when it runs long. The cut falls between whole characters: an emoji
// straddling it is left out whole, never halved into a lone surrogate that
// storage would turn into a replacement character.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeWrapUp } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  CODE_REVISION,
  conversationWorld,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a long first message quoted in the wrap-up', () => {
  let w: ConversationWorld;

  beforeAll(async () => {
    w = await conversationWorld('quotecut');
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('is quoted as a whole-character prefix of the message and an ellipsis', async () => {
    const body = `${'a'.repeat(998)}\u{1F600}z`;
    const conversationId = await started(w, w.owner, { body });
    await w.age(conversationId, 2);
    const wrapped = await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: CODE_REVISION }),
    );
    expect(wrapped).toMatchObject({ ok: true, written: true });
    const [row] = await w.fixture.db.admin.execute<{ readonly quotation: string }>(
      `select request_quotation as quotation from public.conversation_wrap_ups
        where conversation_id = $1`,
      [conversationId],
    );
    const quotation = row?.quotation ?? '';
    expect(quotation).not.toContain('�');
    expect(quotation).not.toMatch(/\p{Cs}/u);
    expect(quotation.endsWith('…')).toBe(true);
    expect(body.startsWith(quotation.slice(0, -1))).toBe(true);
  });
});
