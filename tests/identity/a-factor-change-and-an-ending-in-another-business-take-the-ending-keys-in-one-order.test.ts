// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's session-ending keys on the second-factor path (1010HELD, security
// re-bind SEC-B1A-R5 N1 and N2). A factor act asks its session again after its
// last wait (`judged`), with the business's audit chain held. An ending of that
// session through another business takes that business's chain and the
// session's key, neither of which the act holds, so the act's ask must take
// the session's key too (`sessionEndedHeld`):
// - an ending that holds the key first is waited for, and refuses the act;
// - an ending sent after the act's ask waits for the act to commit, rather
//   than answering "signed out" while the act it ends is still deciding.
// And an act undone by an ending must take the keys in the one order
// (`ending-keys.ts`: the chain, then the sessions), so an ending in its own
// business that reaches its session cannot deadlock it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import type { FactorCaller } from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import {
  endOtherSessions,
  signOutSession,
} from '../../packages/core-commands/src/commands/account-sessions.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import { liveFactor } from '../../packages/core-records/src/identity/second-factor.ts';
import { endOwnSession } from '../../packages/core-records/src/identity/sessions.ts';
import {
  advisoryLock,
  connect,
  type BusinessId,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold, waitingOn, type Held } from '../support/lock-waits.ts';
import {
  backendPid,
  blockedBy,
  lastSessionRead,
  pausedAtProvider,
  stopAt,
  undone,
  type Stopped,
} from './factor-ending-keys-fixture.ts';
import { insertBusiness } from './fixture.ts';
import {
  ACTS,
  factorCaller,
  factorLockKey,
  provider,
  standingElsewhere,
} from './factor-lock-wait-fixture.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

let db: FreshDatabase;
let business: BusinessId;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  db = await createFreshDatabase({ part: 'factorendingkeys' });
  business = (await insertBusiness(db.app, 'factor-ending-keys')) as BusinessId;
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

const EACH = ['enrol', 'verify', 'remove'] as const;

it.each(EACH)(
  'a factor %s whose session is being ended in another business at its last ask waits for the ending, then is refused',
  async (act) => {
    const { caller: asked, person } = await factorCaller(db, business, act !== 'enrol');
    const { business: elsewhere, person: there } = await standingElsewhere(
      db,
      asked.presented.subject,
    );
    const removed: string[] = [];
    const paused = pausedAtProvider(provider(removed));
    const actor = connect(db.appUrl);
    let ending: Held | undefined;
    try {
      let settled = false;
      const acting = ACTS[act]({ ...asked, database: actor }, paused.to).finally(() => {
        settled = true;
      });
      await paused.reached;
      // A sign-out of the act's session through the second business, its keys
      // taken (that business's chain, the session's) and not yet committed.
      let holder = 0;
      ending = await hold(db.appUrl, elsewhere, async (tx) => {
        holder = await backendPid(tx);
        await endOwnSession(tx, there, asked.presented.sessionId);
      });
      paused.goOn();
      await blockedBy(db.admin, holder, () => settled, `the factor ${act}`);
      await ending.letGo();
      ending = undefined;
      const result = await acting;
      const live = await db.app.withBusiness(business, (tx) => liveFactor(tx, person));
      expect({ result, status: live?.status ?? 'none', removed }).toMatchObject({
        result: { refused: true, code: 'AUTH_SESSION_EXPIRED' },
        status: act === 'enrol' ? 'none' : 'verified',
        removed: [],
      });
    } finally {
      paused.goOn();
      await ending?.letGo();
      await actor.close();
    }
  },
);

it.each(EACH)(
  'a sign-out in another business sent after a factor %s asked its session last waits for the act to commit',
  async (act) => {
    const { caller: asked } = await factorCaller(db, business, act !== 'enrol');
    const { business: elsewhere } = await standingElsewhere(db, asked.presented.subject);
    const stop = stopAt(connect(db.appUrl), lastSessionRead);
    const other = connect(db.appUrl);
    try {
      const acting = ACTS[act]({ ...asked, database: stop.database }, provider([]));
      const pid = await stop.stopped;
      let settled = false;
      const signingOut = signOutSession(
        { ...asked, businessId: elsewhere, database: other },
        {},
        provider([]),
      ).finally(() => {
        settled = true;
      });
      try {
        await blockedBy(db.admin, pid, () => settled, 'the sign-out');
      } finally {
        stop.release();
      }
      expect(await acting).not.toMatchObject({ refused: true });
      expect(await signingOut).not.toMatchObject({ refused: true });
    } finally {
      stop.release();
      await Promise.all([stop.database.close(), other.close()]);
    }
  },
);

type Each = (typeof EACH)[number];

/**
 * The act admitted, parked on its factor lock while its session is signed out
 * through the second business, then let go: it sees the ending after its last
 * wait, is undone, and stops straight after the rollback.
 */
async function undoneBySignOut(
  act: Each,
  asked: FactorCaller,
  to: FactorProvider,
): Promise<{ readonly stop: Stopped; readonly acting: Promise<unknown> }> {
  const { business: elsewhere } = await standingElsewhere(db, asked.presented.subject);
  const stop = stopAt(connect(db.appUrl), undone);
  const other = connect(db.appUrl);
  const factorLock = await hold(db.appUrl, business, async (tx) => {
    await advisoryLock(tx, factorLockKey(asked.presented.subject));
  });
  try {
    const acting = ACTS[act]({ ...asked, database: stop.database }, to);
    await waitingOn(db.admin, 'advisory', 'pg_advisory_xact_lock');
    expect(
      await signOutSession({ ...asked, businessId: elsewhere, database: other }, {}, to),
    ).not.toMatchObject({ refused: true });
    return { stop, acting };
  } finally {
    await factorLock.letGo();
    await other.close();
  }
}

/** What a call answered, or the error it failed with (a deadlock is one). */
const answer = (settled: PromiseSettledResult<unknown>): unknown =>
  settled.status === 'fulfilled' ? settled.value : { failed: String(settled.reason) };

/** Another session of the same person here, at full assurance, to end the others from. */
function anotherSession(asked: FactorCaller, database: FactorCaller['database']): FactorCaller {
  const now = Math.floor(Date.now() / 1000) - 2;
  return {
    ...asked,
    database,
    presented: {
      ...asked.presented,
      sessionId: randomUUID(),
      assurance: { level: 'aal2', signedInAt: now, factorAt: now },
    },
  };
}

it.each(EACH)(
  'a factor %s undone by a sign-out ends its session after the audit chain, so ending the other sessions here meanwhile does not deadlock it',
  async (act) => {
    const { caller: asked, person } = await factorCaller(db, business, act !== 'enrol');
    // The act's session is seen here, so ending the others reaches it.
    await db.app.withBusiness(business, (tx) => resolveLogin(tx, asked.presented, 'enrolling'));
    const removed: string[] = [];
    const to = provider(removed);
    const { stop, acting } = await undoneBySignOut(act, asked, to);
    const third = connect(db.appUrl);
    let chain: Held | undefined;
    try {
      await stop.stopped;
      // The undone act holds no key. The chain is taken here, then the other
      // session ends the others, queued on the chain ahead of the act.
      let holder = 0;
      chain = await hold(db.appUrl, business, async (tx) => {
        holder = await backendPid(tx);
        await advisoryLock(tx, business.toLowerCase());
      });
      let ended = false;
      const ending = endOtherSessions(anotherSession(asked, third), {}, to).finally(() => {
        ended = true;
      });
      await blockedBy(db.admin, holder, () => ended, 'ending the other sessions');
      stop.release();
      await blockedBy(db.admin, holder, () => false, 'the undone act', 2);
      await chain.letGo();
      chain = undefined;
      const [actResult, endResult] = (await Promise.allSettled([acting, ending])).map((settled) =>
        answer(settled),
      );
      const live = await db.app.withBusiness(business, (tx) => liveFactor(tx, person));
      expect({ actResult, endResult, status: live?.status ?? 'none', removed }).toMatchObject({
        actResult: { refused: true, code: 'AUTH_SESSION_EXPIRED' },
        endResult: { signedOutAtProvider: true },
        status: act === 'enrol' ? 'none' : 'verified',
        removed: [],
      });
    } finally {
      stop.release();
      await chain?.letGo();
      await Promise.all([stop.database.close(), third.close()]);
    }
  },
);
