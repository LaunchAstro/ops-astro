// SPDX-License-Identifier: AGPL-3.0-only
//
// The person signs out of the session their message came from, on another
// connection, while a carried call's offer or send judgement waits on a lock
// it takes before the session's ending key. The sign-out commits first; the
// judgement then takes the key shared and sees the session ended: nothing is
// offered or sent, and the call is released. Once the send is judged, a
// sign-out waits on the shared key until the write is reported.

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endOwnSession } from '../../packages/core-records/src/identity/sessions.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { signBearer } from '../support/sign-in.ts';
import type { HeldApp } from './carried-exchange-fixture.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, holdAgent, judgementWaits, repliesTo } from './carried-schedules.ts';
import { ISSUER } from './fixture.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The owner's bearer for one provider session, as GoTrue signs it. */
async function sessionToken(subject: string, sessionId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await signBearer({
    sub: subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    exp: now + 600,
    session_id: sessionId,
    amr: [{ method: 'password', timestamp: now + 1 }],
  });
}

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('a sign-out during a carriage judgement', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_sign_out');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['Out.']) });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  const signOut = async (sessionId: string): Promise<void> => {
    await world.w.fixture.db.app.withBusiness(world.w.fixture.business, async (tx) => {
      await endOwnSession(tx, world.w.owner.personId, sessionId);
    });
  };

  it.each(['offer', 'send', 'nothing at the send'] as const)(
    'signed out while the %s judgement waits',
    async (at) => {
      const sessionId = randomUUID();
      const token = await sessionToken(world.w.owner.presented.subject, sessionId);
      const body = `Signed out? (${at})`;
      let holding: Promise<void> = Promise.resolve();
      const hold = async (): Promise<void> => {
        const held: HeldApp<void> = await holdAgent(world);
        holding = (async () => {
          await judgementWaits(world, held);
          if (at !== 'nothing at the send') await signOut(sessionId);
          await held.letGo();
        })();
      };
      if (at === 'offer') world.beforeJoin.run = hold;
      else world.agent.beforeAccept = hold;
      const events = await (await ask(world, body, token)).rest();
      await holding;
      const outcome = JSON.parse(events.at(-1)?.data ?? '{}') as Record<string, unknown>;
      if (at === 'nothing at the send') {
        expect(world.ollama.seen).toHaveLength(1);
        expect(await callFor(world, body)).toMatchObject([{ state: 'settled' }]);
        expect(outcome).toMatchObject({ reply: { answered: true } });
        return;
      }
      expect(world.ollama.seen).toHaveLength(0);
      expect(await callFor(world, body)).toMatchObject([
        { state: 'released', offered: at === 'send', requested: at === 'send' },
      ]);
      expect(await repliesTo(world, body)).toBe(0);
      const said = outcome['reply'] as { readonly answered?: boolean } | null | undefined;
      expect(said?.answered).not.toBe(true);
    },
    60_000,
  );

  it('a sign-out once the send is judged waits until the write is reported', async () => {
    const sessionId = randomUUID();
    const token = await sessionToken(world.w.owner.presented.subject, sessionId);
    const body = 'Signed out mid-send?';
    world.agent.mode = 'unreported';
    const asking = ask(world, body, token);
    await world.agent.dispatched(1);
    const from = Date.now();
    await signOut(sessionId);
    const waited = Date.now() - from;
    expect(world.ollama.seen).toHaveLength(1);
    // The send window's hold, never more than it and the grace after it.
    expect(waited).toBeGreaterThanOrEqual(1_500);
    expect(waited).toBeLessThan(6_000);
    world.agent.release();
    await (await asking).rest();
  }, 60_000);
});
