// SPDX-License-Identifier: AGPL-3.0-only
//
// No paid request reaches OpenRouter before its hold is committed: on every
// receipt the stand-in reads, on another connection, the call `dispatched` at
// the operation's most in its conversation's envelope. The cases send a first
// message, a later one with history, and one on a page.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { HOLD, pricedWorld, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)(
  'every paid send has its committed hold on receipt',
  () => {
    let p: PricedWorld;
    const seenOnReceipt: Record<string, unknown>[][] = [];

    beforeAll(async () => {
      p = await pricedWorld('priced_hold_on_receipt');
      p.openrouter.onReceipt = async () => {
        const rows = await p.w.fixture.db.admin.execute<Record<string, unknown>>(
          `select m.state, m.reserved_minor::text as reserved, e.id as envelope
           from public.model_calls m
           left join public.planning_envelopes e
             on e.business_id = m.business_id and e.id = m.planning_envelope_id
          where m.business_id = $1 and m.provider = 'openrouter' and m.state = 'dispatched'`,
          [p.w.fixture.business],
        );
        seenOnReceipt.push([...rows]);
      };
    }, 180_000);

    afterAll(async () => {
      await p?.stop();
    });

    it('a first message, a later one and one on a page each arrive behind a committed hold', async () => {
      const first = await p.question('What is due today?');
      expect(await p.ask(first)).toMatchObject({ answered: true });
      const later = await p.next(first.conversationId, 'And tomorrow?');
      expect(await p.ask(later)).toMatchObject({ answered: true });
      const made = await p.w.as(p.w.owner, 'task.create', { fields: { title: 'Roster for May' } });
      const paged = await p.question('What is left?', undefined, {
        scope: { kind: 'task', id: String(made.body['recordId']) },
      });
      expect(await p.ask(paged)).toMatchObject({ answered: true });
      expect(seenOnReceipt).toHaveLength(3);
      for (const rows of seenOnReceipt) {
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ state: 'dispatched', reserved: String(HOLD) });
        expect(rows[0]?.['envelope']).not.toBeNull();
      }
    });
  },
);
