// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b sender and AW-07b mention. The sending subdomain's setup check is
// drawn from the fake source (no provider account yet, owner line 68), so
// every report here is `mock`; the send path refuses until it verified. The
// mention cases run the real comment command: a mention someone cannot read
// is refused at compose time, and a client a client-visible comment names is
// told by email through the broker's one send. The client's paid-client
// entitlement is made up here (CS-16.8: no party model stores it yet).

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  checkSender,
  dmarcPolicy,
  fakeSenderSource,
  type FakeSenderState,
} from '../../packages/core-connectors/src/index.ts';
import { sendInboxEmail, tellCommentClients } from '../../packages/core-custody/src/index.ts';
import { writeTaskComment } from '../../packages/core-commands/src/commands/tasks-comment.ts';
import type { TaskRow } from '../../packages/core-commands/src/commands/context.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  raiseMentions,
  readMentions,
  type Mentioned,
} from '../../packages/core-records/src/inbox/mentions.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { declarationOf } from '../../packages/core-wire/src/surface.ts';
import { insertActor, insertPerson } from '../identity/fixture.ts';
import { attemptsOf, itemFor, MAIL, noDatabase, useEmailWorld, w } from './email-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();

const SUBDOMAIN = 'send.example.test';
const ROOT = 'example.test';

const fresh = (): FakeSenderState => ({
  name: SUBDOMAIN,
  dkim: 'verified',
  spf: 'verified',
  returnPathMx: 'verified',
  dmarc: ['v=DMARC1; p=quarantine; pct=100'],
});

// eslint-disable-next-line max-lines-per-function -- each record and each hostile answer, one list
it('AW-07b sender: mail is refused until the sending subdomain verifies DKIM, SPF and the return-path MX', async () => {
  w.provider.mode('accept');
  const unverified: readonly (readonly [string, (state: FakeSenderState) => void])[] = [
    ['DKIM pending', (s) => void (s.dkim = 'pending')],
    ['SPF failed', (s) => void (s.spf = 'failed')],
    ['return-path MX unknown status', (s) => void (s.returnPathMx = 'not_started')],
    ['answer for another subdomain', (s) => void (s.name = 'send.example.com')],
    ['no answer', (s) => void (s.raw = null)],
    ['records not a list', (s) => void (s.raw = { name: SUBDOMAIN, records: 'verified' })],
    [
      'two DKIM records',
      (s) =>
        void (s.raw = {
          name: SUBDOMAIN,
          records: [
            { record: 'DKIM', type: 'TXT', status: 'verified' },
            { record: 'DKIM', type: 'TXT', status: 'pending' },
            { record: 'SPF', type: 'TXT', status: 'verified' },
            { record: 'SPF', type: 'MX', status: 'verified' },
          ],
        }),
    ],
  ];
  for (const [name, bend] of unverified) {
    const state = fresh();
    bend(state);
    // oxlint-disable-next-line no-await-in-loop
    const report = await checkSender(fakeSenderSource(state), SUBDOMAIN, ROOT);
    expect(report.verified, name).toBe(false);
    expect(report.mock, name).toBe(true);
    const item = await itemFor(w.task, 'decision'); // oxlint-disable-line no-await-in-loop
    const received = w.provider.received.length;
    // oxlint-disable-next-line no-await-in-loop
    const sent = await sendInboxEmail(w.db.app, w.alpha, item, w.broker, {
      ...MAIL,
      sender: report,
    });
    expect(sent, name).toEqual({ ok: false, code: 'SENDER_NOT_VERIFIED' });
    expect(w.provider.received.length, name).toBe(received);
    expect(await attemptsOf(item), name).toEqual([]); // oxlint-disable-line no-await-in-loop
  }
  // A subdomain outside the root, and a source that throws, are never verified.
  expect((await checkSender(fakeSenderSource(fresh()), SUBDOMAIN, 'example.com')).verified).toBe(
    false,
  );
  const throwing = {
    mock: true,
    domain: () => Promise.reject(new Error('down')),
    dmarc: async () => await Promise.resolve([]),
  };
  expect((await checkSender(throwing, SUBDOMAIN, ROOT)).verified).toBe(false);

  // All three verified: the report says so, marked mock, and mail goes.
  const report = await checkSender(fakeSenderSource(fresh()), SUBDOMAIN, ROOT);
  expect(report).toEqual({
    subdomain: SUBDOMAIN,
    verified: true,
    records: { dkim: 'verified', spf: 'verified', returnPathMx: 'verified' },
    dmarc: 'quarantine',
    mock: true,
  });
  const item = await itemFor(w.task, 'decision');
  expect(
    await sendInboxEmail(w.db.app, w.alpha, item, w.broker, { ...MAIL, sender: report }),
  ).toMatchObject({
    ok: true,
  });
});

it('AW-07b sender: the setup check reports the root domain’s DMARC policy', () => {
  expect(dmarcPolicy(['v=DMARC1; p=reject; rua=mailto:dmarc@example.test'])).toBe('reject');
  expect(dmarcPolicy(['v=DMARC1;p=none'])).toBe('none');
  expect(dmarcPolicy(['v=DMARC1; p=Quarantine'])).toBe('quarantine');
  expect(dmarcPolicy([])).toBe('missing');
  expect(dmarcPolicy(['v=spf1 -all'])).toBe('missing');
  expect(dmarcPolicy(['v=DMARC1; p=reject', 'v=DMARC1; p=none'])).toBe('invalid');
  expect(dmarcPolicy(['v=DMARC1; p=bogus'])).toBe('invalid');
  expect(dmarcPolicy(['v=DMARC1; rua=mailto:dmarc@example.test'])).toBe('invalid');
});

/** The comment command, as the envelope calls it, on a task in the first business. */
async function comment(
  tx: TenantQuery,
  task: string,
  audience: 'internal' | 'client',
  mentions: readonly string[],
): ReturnType<typeof writeTaskComment> {
  const spine = await installTaskSpine(tx);
  const author = await insertActor(tx, await insertPerson(tx, 'Author'));
  return await writeTaskComment(
    tx,
    {
      commentTypeId: spine.taskCommentTypeId,
      declaration: declarationOf('task.comment'),
      target: { id: task, revision: 1, deleted_at: null } as unknown as TaskRow,
      authorActorId: author,
      entryPoint: 'api',
      audiences: new Set(['internal', 'client']),
      operationId: randomUUID(),
      delegationId: null,
    },
    'Please have a look.',
    audience,
    undefined,
    mentions,
  );
}

/** A client of client A: a read grant on that party only, and a confirmed address. */
async function clientOfA(tx: TenantQuery): Promise<string> {
  const [row] = await tx.query<{ client: string }>(
    `select data->>'client' as client from public.records where business_id = $1 and id = $2`,
    [tx.businessId, w.task],
  );
  const client = await insertPerson(tx, 'Cleo');
  const granted = await issueGrant(tx, [], {
    subject: { kind: 'person', id: client },
    scope: { kind: 'party', id: row?.client ?? '' },
    collection: 'task',
    action: 'read',
    parentGrantId: null,
    grantedByActorId: await insertActor(tx, client),
  });
  if (!granted.ok) throw new Error('mention case: the client grant was refused');
  await tx.query(
    `insert into public.person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
     values ($1, gen_random_uuid(), $2, 'email', 'cleo@example.test', 'cleo@example.test', 'test', 'confirmed')`,
    [tx.businessId, client],
  );
  return client;
}

it('AW-07b mention: a mention of someone who cannot read the subject is refused at compose time, nothing raised or mailed', async () => {
  const received = w.provider.received.length;
  const answers = await w.db.app.withBusiness(w.alpha, async (tx) => {
    const client = await clientOfA(tx);
    return [
      // Another client's task: the recipient holds no read on it.
      await comment(tx, w.otherTask, 'client', [w.person]),
      // A client on a team-only comment, and a person of another business.
      await comment(tx, w.task, 'internal', [client]),
      await comment(tx, w.task, 'client', [w.bravoPerson]),
    ];
  });
  for (const answer of answers) {
    expect(answer).toMatchObject({ refusal: { code: 'MENTION_NOT_READABLE' } });
  }
  const [raised] = await w.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.inbox_items where reason in ('mention', 'client_comment')`,
  );
  expect(raised?.n).toBe('0');
  expect(w.provider.received.length).toBe(received);
});

it('AW-07b mention: a client named in a client-visible comment is told by email, through the send', async () => {
  w.provider.mode('accept');
  const { commentId, client } = await w.db.app.withBusiness(w.alpha, async (tx) => {
    const named = await clientOfA(tx);
    const answer = await comment(tx, w.task, 'client', [named]);
    if ('refusal' in answer) throw new Error('mention case: the client comment was refused');
    const id = String(answer.detail['commentId']);
    // CS-16.8: the item is owed to a paid client; the entitlement is made up here.
    const mentioned = await readMentions(tx, { taskId: w.task, audience: 'client' }, [named]);
    const paid: Mentioned[] = [];
    for (const person of mentioned) paid.push({ ...person, paidClient: true });
    const by = await insertActor(tx, await insertPerson(tx, 'Author'));
    await raiseMentions(
      tx,
      { taskId: w.task, commentId: id, authorActorId: by, audience: 'client' },
      paid,
    );
    return { commentId: id, client: named };
  });
  const results = await tellCommentClients(w.db.app, w.alpha, commentId, w.broker, MAIL);
  expect(results).toEqual([expect.objectContaining({ ok: true, state: 'accepted' })]);
  const message = JSON.parse(w.provider.outbox.at(-1)?.body ?? '{}') as { to: string[] };
  expect(message.to).toEqual(['cleo@example.test']);
  // The comment's id names no other business's items: from there, nothing is sent.
  expect(await tellCommentClients(w.db.app, w.bravo, commentId, w.broker, MAIL)).toEqual([]);
  expect(client).not.toBe(w.person);
});
