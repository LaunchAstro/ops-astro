// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision on a correction racing a change to its client's site. The
// decision locks the correction for update and then waits on the approver
// setting, which a third connection holds; an unbind or a provider move then
// starts on its own connection and waits on the correction, seen in
// pg_stat_activity. Once the decision commits, an approval leaves the site
// frozen (the change refused) and a rejection lets it go through.
//
// A client's site is frozen while any correction of that client is open, so an
// unbind of the client's other page waits for the decision too and is refused
// after an approval.

import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';
import { unbindPartySitePage } from '../../packages/core-records/src/site/party-sites.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import {
  APPROVER,
  BIND,
  freshClient,
  held,
  onOwn,
  moveOf,
  seenWaiting,
  UNBIND,
  waitSeen,
  type FreshClient,
  type Page,
} from './party-site-races.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Decision races: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('decisionrace');
  await w.setApprover(w.ben.personId);
});

/** Ava's request on the client's page, through the command: its correction and version. */
async function requested(client: FreshClient, page: Page) {
  const asked = await w.request(w.ava, {
    partyId: client.partyId,
    taskId: client.taskId,
    pageUrl: page.pageUrl,
    path: page.path,
  });
  expect(codeOf(asked)).toBe('not-a-refusal');
  const detail = detailOf(asked);
  return { correctionId: String(detail['correctionId']), versionId: String(detail['versionId']) };
}

/** The approver setting held for update, so a decision stops after locking its correction. */
const holdApprover = async (tx: TransactionQuery) =>
  await tx.query(
    `select 1 from public.business_settings
      where business_id = $1 and key = 'live_correction_approver' for update`,
    [tx.businessId],
  );

type Change<T> = { readonly run: (tx: TransactionQuery) => Promise<T>; readonly seen: RegExp };

/**
 * Ben's decision holding the correction while `change` runs: the decision seen
 * waiting on the approver setting, the change seen waiting behind it, then the
 * setting let go. The decision's answer and the change's.
 */
async function decidedWhile<T>(
  asked: { readonly correctionId: string; readonly versionId: string },
  decision: 'approve' | 'reject',
  change: Change<T>,
) {
  const blocker = held(w, holdApprover);
  await blocker.ready;
  try {
    const deciding = w.as(w.ben, { command: 'live_correction.decide', ...asked, decision });
    await waitSeen(w, APPROVER);
    const changing = onOwn(w, change.run);
    const settled = Promise.allSettled([deciding, changing]);
    const waited = await seenWaiting(w, change.seen);
    blocker.release();
    const [decided, changed] = await settled;
    if (decided.status === 'rejected') throw decided.reason;
    if (changed.status === 'rejected') throw changed.reason;
    return { waited, decided: codeOf(decided.value), changed: changed.value };
  } finally {
    blocker.release();
    await blocker.done;
  }
}

const unbindOf = (client: FreshClient, page: Page): Change<unknown> => ({
  run: async (tx) => await unbindPartySitePage(tx, client.partyId, page.pageUrl),
  seen: UNBIND,
});

const moveFor = (client: FreshClient): Change<unknown> => ({
  run: moveOf(w, client.partyId),
  seen: BIND,
});

describe.skipIf(serverUrl === undefined)('a decision racing an unbind of its page', () => {
  it('makes the unbind wait for an approval, then refuses it', async () => {
    const client = await freshClient(w);
    const asked = await requested(client, client.pages[0]);
    const raced = await decidedWhile(asked, 'approve', unbindOf(client, client.pages[0]));
    expect(raced).toEqual({
      waited: true,
      decided: 'not-a-refusal',
      changed: { ok: false, code: 'PAGE_UNDER_CORRECTION' },
    });
    expect(await w.stateOf(asked.correctionId)).toBe('approved');
  });

  it('makes the unbind wait for a rejection, then unbinds the page', async () => {
    const client = await freshClient(w);
    const asked = await requested(client, client.pages[0]);
    const raced = await decidedWhile(asked, 'reject', unbindOf(client, client.pages[0]));
    expect(raced).toEqual({ waited: true, decided: 'not-a-refusal', changed: { ok: true } });
    expect(await w.stateOf(asked.correctionId)).toBe('rejected');
  });

  // A client's site is frozen while any correction of it is open: the delete
  // trigger asks only about the page deleted, so the other page goes unwaited.
  it("makes an unbind of the client's other page wait for an approval, then refuses it", async () => {
    const client = await freshClient(w);
    const asked = await requested(client, client.pages[0]);
    const raced = await decidedWhile(asked, 'approve', unbindOf(client, client.pages[1]));
    expect({ waited: raced.waited, changed: raced.changed }).toEqual({
      waited: true,
      changed: { ok: false, code: 'PAGE_UNDER_CORRECTION' },
    });
  });
});

describe.skipIf(serverUrl === undefined)("a decision racing a move of its client's site", () => {
  it('makes the move wait for an approval, then refuses it', async () => {
    const client = await freshClient(w);
    const asked = await requested(client, client.pages[1]);
    const raced = await decidedWhile(asked, 'approve', moveFor(client));
    expect(raced).toEqual({
      waited: true,
      decided: 'not-a-refusal',
      changed: { ok: false, code: 'SITE_UNDER_CORRECTION' },
    });
  });

  it('makes the move wait for a rejection, then moves the providers', async () => {
    const client = await freshClient(w);
    const asked = await requested(client, client.pages[1]);
    const raced = await decidedWhile(asked, 'reject', moveFor(client));
    expect(raced).toEqual({ waited: true, decided: 'not-a-refusal', changed: { ok: true } });
  });
});
