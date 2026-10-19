// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- the businesses, scenes, runs, leases, mandates, custody and broker the C57 shepherd cases share */
//
// C57's review shepherd world (#2017), one per test file: a migrated database with two
// businesses, each with its decider, its active worker and one approved reservation; the fake
// email provider on loopback behind custody's real process, holding the mail credential for the
// `email` destination alone, and a broker over them.
//
// A case takes a scene and a run. A scene is a fresh client of the business (a client row), a
// task under it, the client's own person reading that task through a live party-scoped
// `task:read` grant with a confirmed address, a page review of the task naming the client, and
// its open change requests: each client gets one week of relationship mail, so a case that
// sends uses a client of its own. A run is a real occurrence of a freshly adopted scheduled
// activation, dispatched by the business's worker through the product's own run starter, and a
// live lease on that run held by the worker. The lease row is written by the owner role: the
// worker's lease path for an occurrence run is not built (AW-01), and admin SQL is the world's.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import {
  catalogue,
  emailAdapter,
  startFakeEmailProvider,
  type FakeEmailProvider,
  type ModelOperationDeclaration,
} from '../../packages/core-connectors/src/index.ts';
import {
  sendInboxEmail,
  startCustody,
  type Broker,
  type Custody,
  type EmailResult,
} from '../../packages/core-custody/src/index.ts';
import {
  approveShepherdSendAsPerson,
  occurrenceRunStarter,
  runReviewShepherd,
  type ShepherdApproveOutcome,
  type ShepherdRunOutcome,
  type ShepherdRunRequest,
} from '../../packages/core-commands/src/index.ts';
import {
  adoptVersion,
  claimOccurrence,
  connect,
  dispatchOccurrence,
  insertActivation,
  insertDefinition,
  raiseInboxItem,
  readActivation,
  releaseVersion,
  revokeApproval,
  turnOffActivation,
  type BusinessId,
  type Covering,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { insertMandate, revokeMandate } from '../../packages/core-records/src/mandates/writes.ts';
import { writeComment } from '../../packages/core-records/src/tasks/comments.ts';
import { insertActor, insertPerson } from '../identity/fixture.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { clientHere } from '../reads/client-rows.ts';
import { insertWorker } from '../automations/run-start.ts';
import {
  approve,
  createTask,
  freshPurpose,
  propose,
  seedSchedules,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { MAIL, TEST_EMAIL_SEND } from '../broker/email-world.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

export { MAIL };

export const noDatabase: boolean = databaseUrlFromEnvironment() === undefined;

/** The action class a standing mandate names to cover the shepherd's email. */
export const SHEPHERD_CLASS = 'review.shepherd.email';

const DIGEST = 'b'.repeat(64);

export type Side = 'alpha' | 'bravo';

export interface ShepherdWorld {
  db: FreshDatabase;
  alpha: Schedules;
  bravo: Schedules;
  /** Each business's active worker, and one approved reservation a lease row can name. */
  worker: Record<Side, string>;
  reservation: Record<Side, string>;
  provider: FakeEmailProvider;
  custody: Custody;
  broker: Broker;
  /** The planted mail credential: it must reach the provider's header and nothing else. */
  key: string;
}

export const w = {} as ShepherdWorld;

export const on = (side: Side): Schedules => (side === 'alpha' ? w.alpha : w.bravo);

export const inSide = async <T>(side: Side, work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
  await w.db.app.withBusiness(on(side).business, work);

/** One person of a scene: who they are and the address they were given (if any). */
export interface Person {
  readonly personId: string;
  readonly actorId: string;
  readonly address: string | null;
  readonly grantId: string | null;
}

export interface Scene {
  readonly side: Side;
  readonly client: string;
  readonly task: string;
  readonly review: string;
  /** The client's own person: reads the task through the client's grant, address confirmed. */
  readonly recipient: Person;
  readonly requests: readonly string[];
  readonly marker: string;
}

export interface Run {
  readonly side: Side;
  readonly occurrenceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly activationId: string;
  readonly approvalId: string;
  readonly lease: ShepherdRunRequest['lease'];
}

export type Raised = Extract<ShepherdRunOutcome, { readonly kind: 'raised' }>;

const one = async <T>(sql: string, parameters: readonly unknown[]): Promise<T | undefined> =>
  (await w.db.admin.execute<T & Record<string, unknown>>(sql, parameters as never))[0];

export const count = async (sql: string, parameters: readonly unknown[]): Promise<number> =>
  Number((await one<{ readonly n: string }>(sql, parameters))?.n ?? 0);

/** An address no one else holds, under the planted recipient domain. */
export const freshAddress = (label = 'client'): string =>
  `${label}-${randomBytes(8).toString('hex')}@recipient.example.test`;

export async function confirmAddress(
  tx: TenantQuery,
  person: string,
  value: string,
): Promise<void> {
  await tx.query(
    `insert into public.person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
     values ($1, gen_random_uuid(), $2, 'email', $3, $3, 'test', 'confirmed')`,
    [tx.businessId, person, value],
  );
}

/** A person outside the business's staff, with `task:read` on `client` and an address unless told. */
export async function clientPerson(
  side: Side,
  client: string,
  options: { readonly address?: string | null; readonly granted?: boolean } = {},
): Promise<Person> {
  const address = options.address === undefined ? freshAddress() : options.address;
  return await inSide(side, async (tx) => {
    const personId = await insertPerson(tx, `Client person ${randomUUID().slice(0, 6)}`);
    const actorId = await insertActor(tx, personId);
    let grantId: string | null = null;
    if (options.granted ?? true) {
      const granted = await issueGrant(tx, [], {
        subject: { kind: 'person', id: personId },
        scope: { kind: 'party', id: client },
        collection: 'task',
        action: 'read',
        parentGrantId: null,
        grantedByActorId: on(side).decider.actorId,
      });
      if (!granted.ok) throw new Error('shepherd world: the client read grant was refused');
      grantId = granted.value;
    }
    if (address !== null) await confirmAddress(tx, personId, address);
    return { personId, actorId, address, grantId };
  });
}

export async function revokeGrantOf(side: Side, grantId: string): Promise<void> {
  await inSide(side, async (tx) => {
    await revokeGrant(tx, grantId);
  });
}

/** A task the decider creates, put under `client` (its `data.client`). */
async function taskUnder(side: Side, client: string, title: string): Promise<string> {
  const task = await createTask(on(side), title);
  await inSide(side, async (tx) => {
    await tx.query(
      `update public.records set data = data || jsonb_build_object('client', $2::text)
        where business_id = $1 and id = $3`,
      [tx.businessId, client, task],
    );
  });
  return task;
}

async function commentType(tx: TenantQuery): Promise<string> {
  const [type] = await tx.query<{ readonly id: string }>(
    `select id from public.record_types where business_id = $1 and key = 'task_comment'`,
    [tx.businessId],
  );
  if (type === undefined) throw new Error('shepherd world: no task_comment type');
  return type.id;
}

/** A comment on `task`, by `authorActorId`; the shepherd's own say `source: 'shepherd'`. */
export async function commentOn(
  side: Side,
  task: string,
  body: string,
  authorActorId: string,
  audience: 'client' | 'internal' = 'client',
): Promise<string> {
  return await inSide(
    side,
    async (tx) =>
      await writeComment(tx, await commentType(tx), {
        taskId: task,
        authorActorId,
        commentType: audience === 'client' ? 'client' : 'note',
        audience,
        body,
        source: 'test',
      }),
  );
}

/** One open change request on the review: a client pin carrying the marker, filed as proposed. */
export async function fileRequest(made: Omit<Scene, 'requests'>): Promise<string> {
  const pin = await commentOn(
    made.side,
    made.task,
    `Client pin ${made.marker}`,
    made.recipient.actorId,
  );
  const id = randomUUID();
  await w.db.admin.execute(
    `insert into public.review_change_requests
       (business_id, id, review_id, comment_id, task_id, party_id, request_text,
        proposed_by_actor_id, proposed_by_person_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      on(made.side).business,
      id,
      made.review,
      pin,
      made.task,
      made.client,
      `Move the heading ${made.marker}`,
      on(made.side).decider.actorId,
      on(made.side).decider.personId,
    ],
  );
  return id;
}

/** A fresh client of the business, its task, its own reader, a review and `open` requests. */
export async function scene(
  side: Side = 'alpha',
  options: { readonly open?: number; readonly marker?: string } = {},
): Promise<Scene> {
  const s = on(side);
  const client = await clientHere(w.db.admin, s.business, randomUUID());
  const task = await taskUnder(side, client, `Client page ${randomUUID().slice(0, 6)}`);
  const recipient = await clientPerson(side, client);
  const review = randomUUID();
  await w.db.admin.execute(
    `insert into public.reviews
       (business_id, id, task_id, party_id, kind, page_url, path, revision_count,
        opened_by_actor_id, opened_by_person_id)
     values ($1, $2, $3, $4, 'page', 'https://client.example.test/about', '/about', 2, $5, $6)`,
    [s.business, review, task, client, s.decider.actorId, s.decider.personId],
  );
  const marker = options.marker ?? `marker-${randomBytes(6).toString('hex')}`;
  const base = { side, client, task, review, recipient, marker };
  const requests: string[] = [];
  for (let n = 0; n < (options.open ?? 1); n += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one request after another
    requests.push(await fileRequest(base));
  }
  return { ...base, requests };
}

/** Each earlier occurrence run handed back, so C33's run ceiling never holds the next dispatch. */
async function handBackRuns(side: Side): Promise<void> {
  await w.db.admin.execute(
    `update public.planned_runs set state = 'handed_back'
      where business_id = $1 and origin_occurrence_id is not null
        and state not in ('handed_back', 'cancelled')`,
    [on(side).business],
  );
}

/** A live lease on `runId` held by `holder`, written by the owner role. */
export async function leaseOn(
  side: Side,
  run: { readonly runId: string; readonly taskId: string },
  holder: string,
  fence = 1,
): Promise<ShepherdRunRequest['lease']> {
  const leaseId = randomUUID();
  await w.db.admin.execute(
    `insert into public.leases (business_id, id, task_id, run_id, reservation_id,
        holder_actor_id, authorised_by_person_id, fence, state, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'live', now() + interval '1 hour')`,
    [
      on(side).business,
      leaseId,
      run.taskId,
      run.runId,
      w.reservation[side],
      holder,
      on(side).decider.personId,
      fence,
    ],
  );
  return { leaseId, fence, workerActorId: holder };
}

/**
 * A real occurrence of a freshly adopted scheduled activation, dispatched by the business's
 * worker through the product's run starter, and the worker's live lease on its run.
 */
// eslint-disable-next-line max-lines-per-function -- adopt, claim, dispatch and lease, one run
export async function runOf(side: Side = 'alpha'): Promise<Run> {
  const s = on(side);
  const actorId = s.decider.actorId;
  const adopted = await inSide(side, async (tx) => {
    const definitionId = await insertDefinition(tx, {
      kind: 'automation',
      name: `Review shepherd ${randomUUID().slice(0, 8)}`,
      actorId,
    });
    const version = await releaseVersion(tx, {
      definitionId,
      contentDigest: DIGEST,
      contentSize: 1234,
      inputs: [],
      operations: ['review.shepherd'],
      modes: ['scheduled'],
      actorId,
    });
    if (version === null || version === 'raced') throw new Error(`released ${String(version)}`);
    const activation = await insertActivation(tx, {
      versionId: version.id,
      mode: 'scheduled',
      everyMinutes: 60,
      eventKind: null,
      enabled: true,
      actorId,
    });
    if (activation === null) throw new Error('the activation was not written');
    const adoption = await adoptVersion(tx, {
      activationId: activation.id,
      versionId: version.id,
      expectedRevision: activation.revision,
      act: 'adopted',
      actorId,
    });
    if (adoption.kind !== 'adopted') throw new Error(`the adoption answered ${adoption.kind}`);
    return { activationId: activation.id, approvalId: adoption.approval.id };
  });
  await handBackRuns(side);
  const started = await inSide(side, async (tx) => {
    const claim = await claimOccurrence(tx, adopted.activationId, {
      dueAt: new Date(Date.UTC(2026, 10, 2, 9)),
    });
    if (claim.kind !== 'claimed') throw new Error(`the claim answered ${claim.kind}`);
    const dispatched = await dispatchOccurrence(
      tx,
      claim.occurrence.id,
      occurrenceRunStarter(w.worker[side]),
    );
    if (dispatched.kind !== 'dispatched' || dispatched.dispatch.runId === null) {
      throw new Error(`the dispatch answered ${dispatched.kind}`);
    }
    return { occurrenceId: claim.occurrence.id, runId: dispatched.dispatch.runId };
  });
  const run = await one<{ readonly task_id: string }>(
    'select task_id from public.planned_runs where business_id = $1 and id = $2',
    [s.business, started.runId],
  );
  if (run === undefined) throw new Error('the run has no row');
  const taskId = run.task_id;
  const lease = await leaseOn(side, { runId: started.runId, taskId }, w.worker[side]);
  return { side, ...started, taskId, ...adopted, lease };
}

/** The shepherd's walk-through of `review` under `run`'s lease, in one transaction of `database`. */
export async function shepherd(
  run: Pick<Run, 'side' | 'occurrenceId' | 'lease'>,
  review: string,
  options: { readonly database?: Database; readonly side?: Side } = {},
): Promise<ShepherdRunOutcome> {
  const database = options.database ?? w.db.app;
  return await database.withBusiness(
    on(options.side ?? run.side).business,
    async (tx) =>
      await runReviewShepherd(tx, {
        occurrenceId: run.occurrenceId,
        reviewId: review,
        lease: run.lease,
      }),
  );
}

export function raisedOf(outcome: ShepherdRunOutcome): Raised {
  if (outcome.kind !== 'raised')
    throw new Error(`the shepherd answered ${JSON.stringify(outcome)}`);
  return outcome;
}

/** A scene and a run, and the shepherd's raise of the scene's review under the run. */
export async function raisedScene(
  side: Side = 'alpha',
  options: { readonly open?: number; readonly marker?: string } = {},
): Promise<{ readonly scene: Scene; readonly run: Run; readonly raised: Raised }> {
  const made = await scene(side, options);
  const run = await runOf(side);
  return { scene: made, run, raised: raisedOf(await shepherd(run, made.review)) };
}

/** The open item the shepherd's comment raised for `person`. */
export async function itemOf(raised: Raised, person: string): Promise<string> {
  const row = await one<{ readonly id: string }>(
    `select id from public.inbox_items
      where fact_kind = 'record' and fact_id = $1 and recipient_person_id = $2`,
    [raised.commentId, person],
  );
  if (row === undefined) throw new Error('no item was raised for the person');
  return row.id;
}

/** The people the shepherd's comment raised an item for. */
export async function itemRecipients(commentId: string): Promise<readonly string[]> {
  const rows = await w.db.admin.execute<{ readonly person: string }>(
    `select recipient_person_id::text as person from public.inbox_items
      where fact_kind = 'record' and fact_id = $1 order by recipient_person_id`,
    [commentId],
  );
  return rows.map((row) => row.person);
}

/** The broker's send of one item, through the world's broker unless another is handed. */
export async function send(
  side: Side,
  item: string,
  broker: Broker = w.broker,
): Promise<EmailResult> {
  return await sendInboxEmail(w.db.app, on(side).business as BusinessId, item, broker, MAIL);
}

export type SendResult = EmailResult | { readonly ok: false; readonly code: string };

/** A covering on the decision key the review's own decisions use, for `member`'s person. */
export const coveringOf = (personId: string, within?: readonly string[]): Covering => ({
  subjects: [{ kind: 'person', id: personId, ...(within === undefined ? {} : { within }) }],
  collection: 'proposal',
  action: 'decide',
});

/** `member` approves the send whose digest they saw, under their own covering unless handed one. */
export async function approveAs(
  side: Side,
  member: Pick<Member, 'personId' | 'actorId'>,
  ask: { readonly sendId: string; readonly digest: string },
  covering: Covering = coveringOf(member.personId),
): Promise<ShepherdApproveOutcome> {
  return await inSide(
    side,
    async (tx) =>
      await approveShepherdSendAsPerson(tx, ask, covering, {
        actorId: member.actorId,
        personId: member.personId,
      }),
  );
}

/** The decider approves the raised send's exact digest. */
export async function approved(side: Side, raised: Raised): Promise<void> {
  const answer = await approveAs(side, on(side).decider, {
    sendId: raised.sendId,
    digest: raised.digest,
  });
  if (!answer.ok) throw new Error(`the approval answered ${answer.code}`);
}

/** The shepherd's class on `client`'s graduation list, earned. */
export async function graduated(side: Side, client: string): Promise<void> {
  await w.db.admin.execute(
    `insert into public.graduation_classes
       (business_id, id, client_id, action_class, class_label, clearance, earned,
        approved, edited, rejected, since, note)
     values ($1, gen_random_uuid(), $2, $3, 'Review shepherd email', 'Draft', 'ready',
             30, 1, 0, '2026-08-01', '')
     on conflict (business_id, client_id, action_class) do nothing`,
    [on(side).business, client, SHEPHERD_CLASS],
  );
}

/** A live standing mandate for the shepherd's class on `client`: a cover, or a refusal. */
export async function mandate(side: Side, client: string, refuses = false): Promise<string> {
  await graduated(side, client);
  const filed = await inSide(
    side,
    async (tx) =>
      await insertMandate(tx, {
        clientId: client,
        classes: [SHEPHERD_CLASS],
        refuses,
        ceiling: refuses ? null : { amountMinor: 100, currency: 'AUD' },
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        label: refuses ? 'No shepherd mail' : 'Shepherd mail is fine',
        graduationClass: null,
        actorId: on(side).decider.actorId,
      }),
  );
  if (filed === null) throw new Error('the mandate was not filed');
  return filed.id;
}

/** A covering mandate that runs out `seconds` from now: filed by the owner role, past the filing floor. */
export async function mandateEnding(side: Side, client: string, seconds: number): Promise<string> {
  await graduated(side, client);
  const id = randomUUID();
  await w.db.admin.execute(
    `insert into public.standing_mandates
       (business_id, id, client_id, classes, refuses, ceiling_minor, currency, expires_at,
        label, authored_by_actor_id)
     values ($1, $2, $3, array[$4], false, 100, 'AUD',
             clock_timestamp() + make_interval(secs => $5::double precision), 'Short', $6)`,
    [on(side).business, id, client, SHEPHERD_CLASS, seconds, on(side).decider.actorId],
  );
  return id;
}

export async function revokeMandateOf(side: Side, id: string): Promise<void> {
  await inSide(side, async (tx) => {
    await revokeMandate(tx, id, on(side).decider.actorId);
  });
}

export async function revokeStanding(run: Run): Promise<void> {
  const revoked = await inSide(
    run.side,
    async (tx) =>
      await revokeApproval(tx, {
        approvalId: run.approvalId,
        actorId: on(run.side).decider.actorId,
      }),
  );
  if (revoked !== 'revoked') throw new Error(`the revoke answered ${revoked}`);
}

export async function turnOff(run: Run): Promise<void> {
  const off = await inSide(run.side, async (tx) => {
    const now = await readActivation(tx, run.activationId);
    return await turnOffActivation(tx, {
      activationId: run.activationId,
      expectedRevision: now?.revision ?? 0,
      actorId: on(run.side).decider.actorId,
    });
  });
  if (off.kind !== 'off') throw new Error(`the turn-off answered ${off.kind}`);
}

/** A client comment a worker wrote on `task` (not the shepherd's), and its item for `person`. */
export async function workerCommentItem(side: Side, task: string, person: string): Promise<string> {
  const comment = await commentOn(side, task, 'Your report is ready.', w.worker[side]);
  return await inSide(
    side,
    async (tx) =>
      await raiseInboxItem(tx, {
        recipientPersonId: person,
        subjectRecordId: task,
        reason: 'client_comment',
        fact: { kind: 'record', id: comment },
      }),
  );
}

/** Every email observation of an item, oldest first. */
export async function attemptsOf(
  item: string,
): Promise<readonly { readonly state: string; readonly evidence: string | null }[]> {
  const rows = await w.db.admin.execute<{ state: string; evidence: string | null }>(
    `select state, evidence from public.inbox_delivery_attempts
      where item_id = $1 and channel = 'email' order by observed_seq`,
    [item],
  );
  // Plain rows in a plain array: the driver's result list carries properties of its own.
  return rows.map((row) => ({ state: row.state, evidence: row.evidence }));
}

/** What the shepherd writes, counted in one business. */
export interface Footprint {
  readonly comments: number;
  readonly items: number;
  readonly sends: number;
  readonly audit: number;
}

export async function footprint(side: Side = 'alpha'): Promise<Footprint> {
  const id = on(side).business;
  return {
    comments: await count(
      `select count(*)::text as n from public.records
        where business_id = $1 and data ->> 'source' = 'shepherd'`,
      [id],
    ),
    items: await count(
      `select count(*)::text as n from public.inbox_items
        where business_id = $1 and reason = 'client_comment'
          and fact_id in (select comment_id from public.review_shepherd_sends
                           where business_id = $1
                          union all
                          select id from public.records
                           where business_id = $1 and data ->> 'source' = 'shepherd')`,
      [id],
    ),
    sends: await count(
      'select count(*)::text as n from public.review_shepherd_sends where business_id = $1',
      [id],
    ),
    audit: await count(
      `select count(*)::text as n from public.audit_events
        where business_id = $1 and command like 'review.shepherd%'`,
      [id],
    ),
  };
}

/** A database handle on a pool of its own: its transactions are a backend of their own. */
export const ownPool = (): Database => connect(w.db.appUrl);

/** Another active worker of the business. */
export const anotherWorker = async (side: Side): Promise<string> =>
  await insertWorker(w.db, on(side).business);

/** A member of the business's staff (a membership) with the proposal decision key on `scope`. */
export async function staffDecider(
  side: Side,
  scope:
    | { readonly kind: 'business'; readonly id: null }
    | { readonly kind: 'party'; readonly id: string },
): Promise<Member> {
  const member = await enrol(w.db.app, on(side).business, `decider-${randomUUID().slice(0, 6)}`);
  await inSide(side, async (tx) => {
    await grantTo(tx, member, 'decide', scope, false, 'proposal');
  });
  return member;
}

/** A custody holding the mail key for the `email` destination, listing only `listed`. */
export async function custodyListing(listed: readonly string[]): Promise<{
  readonly custody: Custody;
  readonly broker: Broker;
  readonly stop: () => Promise<void>;
}> {
  const folder = mkdtempSync(join(tmpdir(), 'c57-shepherd-mail-'));
  const credentialsFile = join(folder, 'credentials.json');
  const credential = { kind: 'api_key', account: 'mail-1', header: 'authorization', value: w.key };
  writeFileSync(
    credentialsFile,
    JSON.stringify([{ ref: 'email_key', destination: 'email', ...credential }]),
    { mode: 0o600 },
  );
  const custody = await startCustody({
    credentialsFile,
    destinations: listed.map((key) => ({ key, origin: w.provider.origin })),
  });
  return {
    custody,
    broker: brokerOver(custody, TEST_EMAIL_SEND),
    stop: async () => {
      await custody.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

function brokerOver(custody: Custody, operation: ModelOperationDeclaration): Broker {
  return {
    custody,
    operations: catalogue([operation]),
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

/** A business, its worker, and one approved reservation the world's lease rows name. */
async function business(
  part: string,
): Promise<{ s: Schedules; worker: string; reservation: string }> {
  const s = await seedSchedules(w.db, part, 1_000_000);
  const worker = await insertWorker(w.db, s.business);
  const task = await createTask(s, `Reservation ${part}`);
  const proposal = await propose(s, task, { maximumMinor: 2_000, purpose: freshPurpose() });
  const decision = await approve(s, proposal);
  await w.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'decide', { kind: 'business', id: null }, false, 'proposal');
  });
  return { s, worker, reservation: String(decision['reservationId']) };
}

let folder = '';

async function seed(part: string): Promise<void> {
  process.env['GATE_SIGNING_KEY_ID'] = `test/c57-shepherd-${part}@1`;
  process.env['GATE_SIGNING_SECRET'] = randomUUID();
  w.db = await createFreshDatabase({ part });
  const alpha = await business(`${part}-alpha`);
  const bravo = await business(`${part}-bravo`);
  w.alpha = alpha.s;
  w.bravo = bravo.s;
  w.worker = { alpha: alpha.worker, bravo: bravo.worker };
  w.reservation = { alpha: alpha.reservation, bravo: bravo.reservation };
}

async function startMail(): Promise<void> {
  w.provider = await startFakeEmailProvider();
  folder = mkdtempSync(join(tmpdir(), 'c57-shepherd-'));
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
  w.broker = brokerOver(w.custody, TEST_EMAIL_SEND);
}

/** Build the world before the file's cases and take it all down after. */
export function useShepherdWorld(part: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    await seed(part);
    await startMail();
  }, 180_000);
  afterAll(async () => {
    await w.custody?.stop();
    await w.provider?.close();
    if (folder !== '') rmSync(folder, { recursive: true, force: true });
    await w.db?.drop();
  });
}
