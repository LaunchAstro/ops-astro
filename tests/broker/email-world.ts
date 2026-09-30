// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the AW-07b email cases share, one per test file: a migrated
// database with two businesses, a recipient in the first with a confirmed
// planted address and read on one client's task only, the fake email provider
// on loopback, custody's real process holding the mail credential for the
// `email` destination alone, and a broker over them.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import {
  catalogue,
  EMAIL_SEND,
  emailAdapter,
  startFakeEmailProvider,
  type FakeEmailProvider,
  type ModelOperationDeclaration,
} from '../../packages/core-connectors/src/index.ts';
import {
  startCustody,
  type Broker,
  type Custody,
  type MailSettings,
} from '../../packages/core-custody/src/index.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { raiseInboxItem, type InboxReason } from '../../packages/core-records/src/index.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import { createTask } from '../tasks/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

export const noDatabase: boolean = databaseUrlFromEnvironment() === undefined;

/** A short timeout, declared on the test's own catalogue entry, so a slow answer ends quickly. */
export const TEST_EMAIL_SEND: ModelOperationDeclaration = { ...EMAIL_SEND, timeoutMs: 600 };

export const MAIL: MailSettings = {
  appOrigin: 'https://ops.example.test',
  from: 'hello@example.test',
};

export interface EmailWorld {
  db: FreshDatabase;
  alpha: string;
  bravo: string;
  /** The recipient: read on `task` (client A), none on `otherTask` (client B). */
  person: string;
  /** The planted recipient address: it must reach the provider and nothing else. */
  canary: string;
  task: string;
  otherTask: string;
  bravoTask: string;
  bravoPerson: string;
  provider: FakeEmailProvider;
  custody: Custody;
  broker: Broker;
  key: string;
}

export const w = {} as EmailWorld;

const inAlpha = async <T>(work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
  await w.db.app.withBusiness(w.alpha, work);

/** Raise one open item for the recipient, in the first business unless another is named. */
export async function itemFor(
  task: string,
  reason: InboxReason = 'decision',
  business?: { id: string; person: string },
): Promise<string> {
  const { id, person } = business ?? { id: w.alpha, person: w.person };
  return await w.db.app.withBusiness(
    id,
    async (tx) =>
      await raiseInboxItem(tx, {
        recipientPersonId: person,
        subjectRecordId: task,
        reason,
        fact: { kind: reason === 'decision' ? 'gate' : 'record', id: randomUUID() },
      }),
  );
}

/**
 * Every observation of an item's email attempts, oldest first, with any
 * planted value masked, so a failing case never prints the canary itself.
 */
export async function attemptsOf(
  item: string,
): Promise<readonly { state: string; evidence: string | null }[]> {
  const rows = await w.db.admin.execute<{ state: string; evidence: string | null }>(
    `select state, evidence from public.inbox_delivery_attempts
      where item_id = $1 and channel = 'email' order by observed_seq`,
    [item],
  );
  return rows.map((row) => ({ state: row.state, evidence: masked(row.evidence) }));
}

/** A text with the planted address and any item link masked. */
export function masked<T extends string | null>(text: T): T {
  if (text === null) return text;
  return text
    .split(w.canary.split('@')[0] ?? w.canary)
    .join('[address]')
    .split(`${MAIL.appOrigin}/inbox/`)
    .join('[link]/') as T;
}

async function confirmedAddress(tx: TenantQuery, person: string, value: string): Promise<void> {
  await tx.query(
    `insert into public.person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
     values ($1, gen_random_uuid(), $2, 'email', $3, $3, 'test', 'confirmed')`,
    [tx.businessId, person, value],
  );
}

async function seed(): Promise<void> {
  w.db = await createFreshDatabase({ part: 'aw07b' });
  w.alpha = await insertBusiness(w.db.app, 'alpha');
  w.bravo = await insertBusiness(w.db.app, 'bravo');
  w.canary = `canary-${randomBytes(8).toString('hex')}@recipient.example.test`;
  await inAlpha(async (tx) => {
    const spine = await installTaskSpine(tx);
    w.person = await insertPerson(tx, 'Ada');
    const actor = await insertActor(tx, w.person);
    w.task = await createTask(tx, spine, { title: 'client A work', parentId: null });
    w.otherTask = await createTask(tx, spine, { title: 'client B work', parentId: null });
    const clientA = randomUUID();
    const set = `update public.records set data = data || jsonb_build_object('client', $2::text)
                  where business_id = $1 and id = $3`;
    await tx.query(set, [tx.businessId, clientA, w.task]);
    await tx.query(set, [tx.businessId, randomUUID(), w.otherTask]);
    const granted = await issueGrant(tx, [], {
      subject: { kind: 'person', id: w.person },
      scope: { kind: 'party', id: clientA },
      collection: 'task',
      action: 'read',
      parentGrantId: null,
      grantedByActorId: actor,
    });
    if (!granted.ok) throw new Error('email world: the read grant was refused');
    await confirmedAddress(tx, w.person, w.canary);
  });
  await w.db.app.withBusiness(w.bravo, async (tx) => {
    const spine = await installTaskSpine(tx);
    w.bravoPerson = await insertPerson(tx, 'Bruno');
    const actor = await insertActor(tx, w.bravoPerson);
    w.bravoTask = await createTask(tx, spine, { title: 'bravo work', parentId: null });
    const granted = await issueGrant(tx, [], {
      subject: { kind: 'person', id: w.bravoPerson },
      scope: { kind: 'business', id: null },
      collection: 'task',
      action: 'read',
      parentGrantId: null,
      grantedByActorId: actor,
    });
    if (!granted.ok) throw new Error('email world: the bravo grant was refused');
    await confirmedAddress(tx, w.bravoPerson, `bravo-${w.canary}`);
  });
}

let folder = '';

async function startMail(): Promise<void> {
  w.provider = await startFakeEmailProvider();
  folder = mkdtempSync(join(tmpdir(), 'aw07b-mail-'));
  w.key = `mailkey-${randomBytes(18).toString('hex')}`;
  const credentialsFile = join(folder, 'credentials.json');
  const credential = { kind: 'api_key', account: 'mail-1', header: 'authorization', value: w.key };
  writeFileSync(
    credentialsFile,
    JSON.stringify([{ ref: 'email_key', destination: 'email', ...credential }]),
    { mode: 0o600 },
  );
  w.custody = await startCustody({
    credentialsFile,
    destinations: [{ key: 'email', origin: w.provider.origin }],
  });
  w.broker = {
    custody: w.custody,
    operations: catalogue([TEST_EMAIL_SEND]),
    providers: new Map([['resend', { build: emailAdapter, price: () => 0 }]]),
    routes: [
      {
        key: 'email',
        reach: 'cloud',
        provider: 'resend',
        credentialRef: 'email_key',
        credentialKind: 'api_key',
        installation: 'here',
        ceiling: 4,
      },
    ],
    installation: 'here',
    audit: async () => {},
  };
}

/** Build the world before the file's cases and take it all down after. */
export function useEmailWorld(): void {
  beforeAll(async () => {
    await seed();
    await startMail();
  }, 120_000);
  afterAll(async () => {
    await w.custody?.stop();
    await w.provider?.close();
    if (folder !== '') rmSync(folder, { recursive: true, force: true });
    await w.db?.drop();
  });
}
