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

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationExchange } from '../../packages/core-commands/src/index.ts';
import type { Admit, Custody } from '../../packages/core-custody/src/custody.ts';
import { endOwnSession } from '../../packages/core-records/src/identity/sessions.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { CONVERSATION } from '../api/aw-03-fixture.ts';
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
