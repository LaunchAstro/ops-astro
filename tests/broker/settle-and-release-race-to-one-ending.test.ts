// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid call ends once. Every move is a conditional update under the call's
// row lock, so whichever writer comes second finds the call ended and moves
// nothing:
//
//   (a) the owner records that nothing happened, then the late answer comes:
//       the answer moves no money, keeps no reply, and the loss is recorded;
//   (b) the sweep holds the call, then the answer comes: the answer settles it
//       at its cost; the answer first, then the sweep: the sweep moves nothing;
//   (c) the owner records that it happened, then a release comes: the call
//       stays settled at its most.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { centsOf, HOLD, pricedWorld, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// oxlint-disable-next-line max-lines-per-function -- one world, a schedule per pair of writers
describe.skipIf(serverUrl === undefined)('settle and release race to one ending', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_one_ending');
    // An owner records a held call's outcome with billing's decide.
    await p.w.fixture.db.app.withBusiness(p.w.fixture.business, async (tx) => {
      await grantTo(tx, p.w.owner, 'decide', undefined, false, 'billing');
    });
  }, 180_000);

  afterAll(async () => {
    p?.openrouter.open();
    await p?.stop();
  });

  const replies = async (conversationId: string): Promise<number> =>
    await p.w.count(
      `select count(*)::text as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  /** The owner records the held call's outcome, as the person's own command. */
  const record = async (conversationId: string, callId: unknown, outcome: string) =>
    await executeCommand(p.w.fixture.db.app, p.w.fixture.business, p.w.owner.presented, 'api', {
      command: 'budget.record_outcome',
      operationId: randomUUID(),
      recordId: conversationId,
      attemptId: callId,
      outcome,
    } as never);

  /** A paid call held at OpenRouter, then swept to held: its id and the answer still to come. */
  async function sweptInFlight(): Promise<{
    readonly conversationId: string;
    readonly callId: unknown;
    readonly reply: ReturnType<PricedWorld['ask']>;
  }> {
    const asked = await p.question('What is due today?');
    const arrivals = p.openrouter.received.length;
    p.openrouter.shut();
    const reply = p.ask(asked);
    await p.openrouter.arrived(arrivals + 1);
    await p.sweep(asked.conversationId);
    const [call] = await p.calls(asked.conversationId);
    expect(call).toMatchObject({ state: 'liability_unknown' });
    return { conversationId: asked.conversationId, callId: call?.['id'], reply };
  }

  it('(a) nothing happened, then the late answer: no money, no reply, the loss recorded', async () => {
    const before = await p.committed();
    const { conversationId, callId, reply } = await sweptInFlight();
    expect(await record(conversationId, callId, 'nothing_happened')).toMatchObject({
      detail: { outcome: 'nothing_happened' },
    });
    p.openrouter.open();
    expect(await reply).toMatchObject({ answered: false, code: 'DECISION_STALE' });
    const [call] = await p.calls(conversationId);
    expect(call).toMatchObject({ state: 'released', actual_minor: null });
    expect(await replies(conversationId)).toBe(0);
    expect(await p.committed()).toBe(before);
    const lost = await p.w.count(
      `select count(*)::text as n from public.audit_events
        where command = 'model.call_settle_lost' and business_id = $1`,
      [p.w.fixture.business],
    );
    expect(lost).toBe(1);
  });

  it('(b) the sweep, then the answer: settled at its cost with its reply', async () => {
    const { conversationId, reply } = await sweptInFlight();
    p.openrouter.open();
    expect(await reply).toMatchObject({ answered: true });
    const [call] = await p.calls(conversationId);
    expect(call).toMatchObject({ state: 'settled', actual_minor: String(centsOf(0.000_3)) });
    expect(await replies(conversationId)).toBe(1);
  });

  it('(b) the answer, then the sweep: the sweep moves nothing', async () => {
    const asked = await p.question('What is due today?');
    expect(await p.ask(asked)).toMatchObject({ answered: true });
    await p.sweep(asked.conversationId);
    expect(await p.calls(asked.conversationId)).toMatchObject([
      { state: 'settled', actual_minor: String(centsOf(0.000_3)) },
    ]);
  });

  it('(c) it happened, then a release: settled at its most, nothing kept', async () => {
    p.openrouter.answer = () => ({ status: 402, body: '{"error":{"code":402}}' });
    const { conversationId, callId, reply } = await sweptInFlight();
    expect(await record(conversationId, callId, 'happened')).toMatchObject({
      detail: { outcome: 'happened' },
    });
    p.openrouter.open();
    expect(await reply).toMatchObject({ answered: false, code: 'DECISION_STALE' });
    const [call] = await p.calls(conversationId);
    expect(call).toMatchObject({ state: 'settled', actual_minor: String(HOLD) });
    expect(await replies(conversationId)).toBe(0);
  });
});
