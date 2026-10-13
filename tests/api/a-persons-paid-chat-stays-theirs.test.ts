// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's paid chat stays theirs. Once A has a paid reply settled, B, with
// billing's decide and listed for the paid model too, is refused A's
// conversation spend, cannot record the outcome of A's held call, cannot have
// A's message answered, and while both are answered at once each hears only
// their own answer's pieces.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { sse } from './openrouter-stand-in-fixture.ts';
import { HAIKU, listed, pricedWorld, type PricedWorld } from '../broker/priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** Each request answered with its own question, long enough to stream past the held-back tail. */
const echo = (request: { readonly body: Record<string, unknown> }) => {
  const messages = request.body['messages'] as { content: string }[];
  const said = `You asked: ${messages.at(-1)?.content ?? ''}. `.repeat(6);
  return { status: 200, chunks: sse(HAIKU, [said.slice(0, 200), said.slice(200)]), holdAfter: 2 };
};

// oxlint-disable-next-line max-lines-per-function -- two people, four ways one could reach the other
describe.skipIf(serverUrl === undefined)("a person's paid chat stays theirs", () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld(
      'priced_stays_theirs',
      (business, owner) => [listed(business, owner)],
      2,
      true,
    );
    listColleagueToo();
    await p.w.fixture.db.app.withBusiness(p.w.fixture.business, async (tx) => {
      await grantTo(tx, p.w.colleague, 'decide', undefined, false, 'billing');
    });
  }, 180_000);

  /** The colleague is listed as well, in the broker and in the offer. */
  function listColleagueToo(): void {
    const pairs = [
      listed(p.w.fixture.business, p.w.owner),
      listed(p.w.fixture.business, p.w.colleague),
    ];
    process.env['OPS_OUTSIDE_MODEL_PEOPLE'] = pairs.join(',');
    Object.assign(p.broker, { outsidePeople: pairs });
  }

  afterAll(async () => {
    await p?.stop();
  });

  it("B reads none of A's spend, records nothing on A's held call, and cannot have A's message answered", async () => {
    const { db, business } = p.w.fixture;
    const paidFor = await p.question('What is due today?');
    expect(await p.ask(paidFor)).toMatchObject({ answered: true });
    p.openrouter.answer = () => ({ status: 503, body: '{}' });
    const heldFor = await p.question('And tomorrow?');
    await p.ask(heldFor);
    const [held] = await p.calls(heldFor.conversationId);
    expect(held).toMatchObject({ state: 'liability_unknown' });
    const spend = await p.w.as(p.w.colleague, 'conversation.allowance', {
      conversationId: paidFor.conversationId,
    });
    // Another person's conversation is no conversation of B's: not found, nothing read.
    expect(spend.body).toMatchObject({ refused: true, code: 'NOT_FOUND' });
    const recorded = await executeCommand(db.app, business, p.w.colleague.presented, 'api', {
      command: 'budget.record_outcome',
      operationId: randomUUID(),
      recordId: heldFor.conversationId,
      attemptId: held?.['id'],
      outcome: 'nothing_happened',
    } as never);
    expect(recorded).toMatchObject({ refused: true });
    expect(await p.calls(heldFor.conversationId)).toMatchObject([{ state: 'liability_unknown' }]);
    const sent = p.openrouter.received.length;
    expect(await p.exchange(db.app, business, p.w.colleague.presented, paidFor)).toBeNull();
    expect(p.openrouter.received.length).toBe(sent);
  });

  it('answered at once, each hears only their own pieces', async () => {
    const { db, business } = p.w.fixture;
    p.openrouter.answer = echo;
    const before = p.openrouter.received.length;
    const mine = await p.question('Alpha question');
    const theirs = await p.question('Bravo question', p.w.colleague);
    const heard: Record<string, string[]> = { mine: [], theirs: [] };
    const a = p.exchange(db.app, business, p.w.owner.presented, mine, (t) =>
      heard['mine']?.push(t),
    );
    const b = p.exchange(db.app, business, p.w.colleague.presented, theirs, (t) =>
      heard['theirs']?.push(t),
    );
    await p.openrouter.arrived(before + 2);
    await p.openrouter.midway();
    p.openrouter.resume();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toMatchObject({ answered: true });
    expect(rb).toMatchObject({ answered: true });
    expect(heard['mine']?.join('')).toBe(ra?.answered ? ra.body : '');
    expect(heard['theirs']?.join('')).toBe(rb?.answered ? rb.body : '');
    expect(heard['mine']?.join('')).not.toContain('Bravo');
    expect(heard['theirs']?.join('')).not.toContain('Alpha');
  });
});
