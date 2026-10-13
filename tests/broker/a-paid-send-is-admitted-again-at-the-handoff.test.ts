// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid send is judged again at the handoff to custody, after its hold:
//
//   - a grant revoked, the session ended, the conversation given to another
//     person or moved back to the free model between the hold and the send: nothing is sent, the call
//     is released, and the whole hold is freed;
//   - a revocation started once the send is admitted waits on the admission
//     (it is seen waiting) until custody has started the send, so exactly one
//     request goes out, and the revocation lands only after the handoff;
//   - a grant row someone else holds at that moment admits nothing, at once,
//     with no deadlock.
//
// On a carried deployment the paid call goes through the offer and send
// judgements, which judge its outside standing too: the grant revoked before
// the offer, or the grant, the agent's membership, the agent, or the person's
// place on the outside list (a settings reload) gone after the offer and
// before the send: nothing is sent, the call is released, and the whole hold
// is freed. A revocation once the send is judged waits until the agent
// reports the write, and the one request goes.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationExchange } from '../../packages/core-commands/src/index.ts';
import type { Admit, Custody } from '../../packages/core-custody/src/custody.ts';
import { endOwnSession } from '../../packages/core-records/src/identity/sessions.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { CONVERSATION } from '../api/aw-03-fixture.ts';
import { carriedWorld, PAID_HOLD, type CarriedWorld } from '../api/carried-world.ts';
import {
  ask,
  callFor,
  deactivateAgent,
  heldFor,
  leaveMembership,
  repliesTo,
  revokeOwn,
} from '../api/carried-schedules.ts';
import { HAIKU } from '../api/openrouter-stand-in-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { holdRow } from '../support/lock-wait-race.ts';
import { pricedWorld, type Asked, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** Custody whose dispatch runs `before` first, and `admitted` once a send is admitted. */
const wrapping =
  (
    before: () => Promise<void>,
    admitted: () => Promise<void> = async () => await Promise.resolve(),
  ) =>
  (broker: PricedWorld['broker']): PricedWorld['broker'] => {
    const custody: Custody = broker.custody;
    const wrapAdmit = (admit: Admit | undefined): Admit | undefined =>
      admit === undefined
        ? undefined
        : async () => {
            const admission = await admit();
            if (admission !== undefined) await admitted();
            return admission;
          };
    return {
      ...broker,
      custody: {
        ...custody,
        dispatch: async (ref, request, onPiece, admit) => {
          await before();
          return await custody.dispatch(ref, request, onPiece, wrapAdmit(admit));
        },
      },
    };
  };

// oxlint-disable-next-line max-lines-per-function -- one world, a schedule per way the send can lose its footing
describe.skipIf(serverUrl === undefined)('a paid send is admitted again at the handoff', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_handoff');
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  const GRANTS = `public.grants
     where business_id = $1 and collection = 'conversation' and revoked_at is null
       and subject_id in ($2, $3)`;
  const grantArgs = () => [p.w.fixture.business, p.w.owner.personId, p.w.owner.actorId];
  /** On a connection of its own, so a revocation that waits holds up nobody's reads. */
  const revoke = async (): Promise<void> => {
    const url = new URL(String(serverUrl));
    url.pathname = `/${p.w.fixture.db.name}`;
    const own = connectAsAdmin(url.toString());
    await own.execute(
      `update public.grants set revoked_at = clock_timestamp()
        where business_id = $1 and collection = 'conversation' and revoked_at is null
          and subject_id in ($2, $3)`,
      grantArgs(),
    );
    await own.close();
  };
  const regrant = async (): Promise<void> => {
    await p.w.fixture.db.app.withBusiness(p.w.fixture.business, async (tx) => {
      await grantTo(tx, p.w.owner, 'write', undefined, false, CONVERSATION);
    });
  };

  async function notAdmitted(
    asked: Asked,
    exchange: ConversationExchange,
    presented = p.w.owner.presented,
  ): Promise<void> {
    const { db, business } = p.w.fixture;
    const before = await p.committed();
    const sent = p.openrouter.received.length;
    expect(await exchange(db.app, business, presented, asked)).toMatchObject({
      answered: false,
      code: 'CUSTODY_NOT_ADMITTED',
    });
    expect(p.openrouter.received.length).toBe(sent);
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'released' }]);
    expect(await p.committed()).toBe(before);
  }

  it('a grant revoked between the hold and the send: nothing sent, the hold freed', async () => {
    const asked = await p.question('What is due today?');
    await notAdmitted(asked, await p.twin(wrapping(revoke)));
    await regrant();
  });

  it('the conversation given to another person before the send: nothing sent', async () => {
    const asked = await p.question('What is due today?');
    const move = async (): Promise<void> => {
      await p.w.fixture.db.admin.execute(
        `update public.conversations set owner_actor_id = $2, owner_person_id = $3 where id = $1`,
        [asked.conversationId, p.w.colleague.actorId, p.w.colleague.personId],
      );
    };
    await notAdmitted(asked, await p.twin(wrapping(move)));
  });

  it('the conversation moved back to the free model before the send: nothing sent', async () => {
    const asked = await p.question('What is due today?');
    const free = async (): Promise<void> => {
      await p.w.fixture.db.admin.execute(
        'update public.conversations set model_id = null where id = $1',
        [asked.conversationId],
      );
    };
    await notAdmitted(asked, await p.twin(wrapping(free)));
  });

  it('a grant row held elsewhere at the send admits nothing, at once', async () => {
    const asked = await p.question('What is due today?');
    const [grant] = await p.w.fixture.db.admin.execute<{ readonly id: string }>(
      `select id from ${GRANTS}`,
      grantArgs(),
    );
    let held: Awaited<ReturnType<typeof holdRow>> | undefined;
    const lockGrant = async (): Promise<void> => {
      held = await holdRow(p.w.fixture.db, 'select 1 from public.grants where id = $1 for update', [
        grant?.id,
      ]);
    };
    await notAdmitted(asked, await p.twin(wrapping(lockGrant)));
    await held?.letGo();
  });

  it('a revocation started once the send is admitted waits for custody; one request goes', async () => {
    const asked = await p.question('What is due today?');
    const sent = p.openrouter.received.length;
    let revoking: Promise<void> | undefined;
    let revoked = false;
    const pendingAtAdmission: boolean[] = [];
    const startRevoking = async (): Promise<void> => {
      revoking = (async () => {
        await revoke();
        revoked = true;
      })();
      for (let tries = 0; tries < 500; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- polls the server
        const waiting = await p.w.count(
          `select count(*)::text as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and query like '%update public.grants%'`,
          [],
        );
        if (waiting > 0) {
          pendingAtAdmission.push(!revoked);
          return;
        }
        // oxlint-disable-next-line no-await-in-loop -- polls the server
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      throw new Error('the revocation never waited on the admission');
    };
    const exchange = await p.twin(wrapping(async () => await Promise.resolve(), startRevoking));
    const { db, business } = p.w.fixture;
    await exchange(db.app, business, p.w.owner.presented, asked);
    await revoking;
    expect(pendingAtAdmission).toStrictEqual([true]);
    expect(p.openrouter.received.length).toBe(sent + 1);
    // Revoked before the reply could be kept: its most stays held, nothing kept.
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'liability_unknown' }]);
    await regrant();
  });

  it('the session ended between the hold and the send: nothing sent', async () => {
    const presented = { ...p.w.owner.presented, sessionId: randomUUID() };
    const asked = await p.question('What is due today?');
    const end = async (): Promise<void> => {
      await p.w.fixture.db.app.withBusiness(p.w.fixture.business, async (tx) => {
        await endOwnSession(tx, p.w.owner.personId, presented.sessionId);
      });
    };
    await notAdmitted(asked, await p.twin(wrapping(end)), presented);
  });
});

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('a carried paid send is judged again', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carried_paid_handoff', undefined, {}, true);
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  const inBusiness = async (change: (tx: TenantQuery) => Promise<void>): Promise<void> => {
    await world.database.withBusiness(world.w.fixture.business, change);
  };
  const changes: Record<string, (k: string) => Promise<void>> = {
    'the grant revoked': async () => await inBusiness(async (tx) => await revokeOwn(world, tx)),
    'the membership left': async (k) =>
      await inBusiness(async (tx) => await leaveMembership(tx, k)),
    'the agent deactivated': async () =>
      await inBusiness(async (tx) => await deactivateAgent(world, tx)),
    // The broker's settings reloaded without the person: the list it judges by is the live one.
    'the person dropped from the outside list': async () => {
      await Promise.resolve(world.outsidePeople.splice(0));
    },
  };

  async function nothingSent(body: string, events: readonly { readonly data: string }[]) {
    expect(world.agent.sent).toHaveLength(0);
    expect(world.openrouter?.received).toHaveLength(0);
    expect(await heldFor(world, body)).toEqual([{ reserved: PAID_HOLD, committed: 0 }]);
    expect(await repliesTo(world, body)).toBe(0);
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: false } });
  }

  it('the grant revoked before the offer: nothing offered or sent, the whole hold freed', async () => {
    const body = 'Due, paid? (revoked before the offer)';
    world.beforeJoin.run = async () => await inBusiness(async (tx) => await revokeOwn(world, tx));
    const events = await (await ask(world, body, undefined, undefined, HAIKU)).rest();
    expect(await callFor(world, body)).toEqual([
      { state: 'released', offered: false, requested: false, actual: null },
    ]);
    await nothingSent(body, events);
  }, 60_000);

  it.each(Object.keys(changes))(
    '%s after the offer, before the send: nothing sent, the whole hold freed',
    async (change) => {
      const body = `Due, paid? (${change})`;
      world.agent.beforeAccept = async (k) => await changes[change]?.(k);
      const events = await (await ask(world, body, undefined, undefined, HAIKU)).rest();
      expect(await callFor(world, body)).toEqual([
        { state: 'released', offered: true, requested: true, actual: null },
      ]);
      await nothingSent(body, events);
    },
    60_000,
  );

  it('a revocation once the paid send is judged waits until the write is reported; one request', async () => {
    const body = 'Due, paid? (revoked once judged)';
    const asking = ask(world, body, undefined, undefined, HAIKU);
    await world.agent.dispatched(1);
    const sentAt = Date.now();
    await inBusiness(async (tx) => await revokeOwn(world, tx));
    expect(world.openrouter?.received).toHaveLength(1);
    expect(Date.now() - sentAt).toBeLessThan(1_500);
    await (await asking).rest();
    expect(await callFor(world, body)).toMatchObject([{ requested: true }]);
  }, 60_000);
});
