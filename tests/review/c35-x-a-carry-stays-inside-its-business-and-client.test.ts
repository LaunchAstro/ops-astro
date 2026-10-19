// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- two clients' reviews and every crossing in one place */
//
// C35-X (#2075): a carry reaches only the review on its lease's own task. A revision of
// another client's review, named under this lease, is not found; the same call in another
// business is refused; neither writes a carry anywhere. A carry takes only its own review's
// pins, a reader granted another client's reviews reads none of it, and the client's
// projection of the task shows its own pin and never an internal one or its carry.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { shareWithClient, type Member } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { B_FILE, B_PAGE, c35World, spot, type C35World } from './c35-world.ts';
import { agentLogin } from './c35-landing.ts';
import {
  carriesOnto,
  carryCount,
  carryUnder,
  landPage,
  landedReview,
  must,
  nextRevision,
  pinOn,
  quote,
} from './c35-x-carry.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X carry isolation: DATABASE_URL is unset.');

const INTERNAL_MARKER = 'team only: carry-marker-7719';
const PAGE_ONE = { text: 'Book a visit today. Our team.', document: 'a' };
const PAGE_TWO = { text: 'Book a visit today. Meet the team.', document: 'e' };

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35xisol');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35-X isolation of the carry', () => {
  it('C35-X isolation: a carry stays inside its business, its client and its own review', async () => {
    const atB = { partyId: w.partyB, pageUrl: B_PAGE, path: B_FILE };
    const a = await landedReview(w, 'client A review', PAGE_ONE);
    const b = await landedReview(w, 'client B review', PAGE_ONE, atB);
    const clientPin = await pinOn(w, a.reviewed.revisionId, {
      audience: 'client',
      body: 'Is this the booking line you wanted?',
      selector: [spot(), quote('Book a visit today')],
    });
    await pinOn(w, a.reviewed.revisionId, { body: INTERNAL_MARKER });
    const pinOfB = await pinOn(w, b.reviewed.revisionId, {
      selector: [spot(), quote('Book a visit today')],
    });
    const secondA = await nextRevision(w, a.reviewed);
    const secondB = await nextRevision(w, b.reviewed, atB);
    await landPage(w, a.lease, secondA, PAGE_TWO);
    await landPage(w, b.lease, secondB, PAGE_TWO);
    const alpha = await carryCount(w, w.world.business);
    const beta = await carryCount(w, w.beta);

    // Client B's revision under client A's lease, and the call made in another business.
    expect(codeOf((await carryUnder(w, a.lease, secondB)).result)).toBe('NOT_FOUND');
    const elsewhere = await executeAgentCommand(
      w.world.db.app,
      w.beta,
      agentLogin(w),
      a.lease.credential,
      {
        operationId: crypto.randomUUID(),
        command: 'review.carry_pins',
        leaseId: a.lease.leaseId,
        fence: a.lease.fence,
        revisionId: secondA,
      } as never,
    );
    expect(codeOf(elsewhere as never)).not.toBe('not-a-refusal');
    expect([await carryCount(w, w.world.business), await carryCount(w, w.beta)]).toStrictEqual([
      alpha,
      beta,
    ]);

    // Each review's carry takes its own pins only.
    must((await carryUnder(w, a.lease, secondA)).result, 'carry A');
    must((await carryUnder(w, b.lease, secondB)).result, 'carry B');
    expect((await carriesOnto(w, secondA)).map((row) => row.comment_id)).not.toContain(pinOfB);
    expect((await carriesOnto(w, secondB)).map((row) => row.comment_id)).toStrictEqual([pinOfB]);

    // dee holds review keys on client B only: client A's review is not found.
    expect(codeOf((await w.read(w.dee, a.reviewed.reviewId)) as never)).toBe('NOT_FOUND');

    // The client's projection of the task: its own pin, never the internal one or a carry.
    const client: Member = await shareWithClient(
      w.world.db.app,
      w.world.business,
      w.admin,
      a.reviewed.taskId,
    );
    const read = await executeRead(w.world.db.app, w.world.business, client.presented, {
      read: 'task.read',
      recordId: a.reviewed.taskId,
    } as never);
    if (!('sharedTask' in read)) throw new Error(`task.read answered ${JSON.stringify(read)}`);
    const ids = (read.sharedTask.comments as readonly Readonly<Record<string, unknown>>[]).map(
      (comment) => comment['id'],
    );
    expect(ids).toContain(clientPin);
    const text = JSON.stringify(read);
    expect(text).not.toContain(INTERNAL_MARKER);
    expect(text).not.toContain(secondA);
    expect(text).not.toContain('lost');
  }, 120_000);
});
