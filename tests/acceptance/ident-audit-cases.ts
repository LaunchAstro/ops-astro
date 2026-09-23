// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the identifier negatives and the per-operation audit proofs are
// driven against, and the questions both of them ask it.
//
// It is `role-case-harness.ts`'s world with the identities the matrix does not
// build, because the matrix's (c) and (d) cells swap one operand kind, a task
// record, and ledger rows I03, I04 and I13 are about every kind:
//
// - **bravo's own work in flight.** An admin and an agent of bravo, a task, a
//   proposal (gate, version, lineage), an approved reservation, a live lease
//   and delegation, a trash batch and a grant, each made through bravo's own
//   routes. A foreign identifier is only foreign if it names something that
//   really exists somewhere else, so every one is read back from bravo's rows.
// - **a second alpha agent** with a live lease: for an agent operand, the
//   same-business identifier it may not reach is another agent's lease.
// - **`rhea`**, a member of alpha whose task grants name one record, because
//   a business-scoped admin can reach every alpha task.
//
// Nothing below the boundary is substituted. Fixture grants go through
// `issueGrant` via `grantTo`; every probe and control goes through `call`.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import type { CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { pathOf } from '../../packages/core-records/src/commands/surface.ts';
import { DELEGATION_HEADER } from '../../apps/api/app.ts';
import { ADMIN_ACTIONS, ADMIN_COLLECTIONS, enrolAgent, enrolCaller } from './cast.ts';
import { createHarness, type Harness } from './role-case-harness.ts';
import { PROPOSAL, type Task } from './role-case-bodies.ts';
import {
  agentPath,
  bearer,
  call,
  personPath,
  type AgentIdentity,
  type Answer,
  type Caller,
} from './world.ts';

type Body = Readonly<Record<string, unknown>>;

/** A pickup's answer: the handles an agent operand names. */
export type Picked = Readonly<
  Record<'taskId' | 'leaseId' | 'delegationId' | 'credential' | 'reservationId', string> & {
    fence: number;
  }
>;
/** A proposal's handles. */
export type Proposed = Readonly<
  Record<'gateId' | 'versionId' | 'lineageId', string> & { task: Task }
>;

type PersonCall = (
  caller: { readonly token: string },
  name: CommandName,
  body: Body,
  businessKey?: string,
) => Promise<Answer>;
type AgentCall = (
  identity: AgentIdentity,
  name: CommandName,
  body: Body,
  credential?: string,
  businessKey?: string,
) => Promise<Answer>;

export interface IdentWorld {
  readonly h: Harness;
  /** What bravo owns that an alpha caller could be handed the identifier of. */
  readonly foreign: Readonly<{
    admin: Caller;
    task: Task;
    proposal: Proposed;
    picked: Picked;
    batchId: string;
    grantId: string;
  }>;
  /** The second alpha agent's live pickup. */
  readonly otherPicked: Picked;
  /** A member of alpha holding task grants on `rheaTask` and nothing else. */
  readonly rhea: Caller;
  readonly rheaTask: Task;
  readonly person: PersonCall;
  readonly agent: AgentCall;
  /** Propose on a fresh alpha task as the admin. */
  propose(title: string): Promise<Proposed>;
  /** Propose, approve, and hand the reservation to `identity`'s pickup. */
  pickUp(identity: AgentIdentity, title: string): Promise<Picked>;
  close(): Promise<void>;
}

const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

function need(answer: Answer, what: string): Record<string, unknown> {
  if (answer.code !== 'ok') {
    throw new Error(`ident-audit: ${what} refused ${answer.code} ${JSON.stringify(answer.body)}`);
  }
  return detailOf(answer);
}

/** The actions `rhea` is given on her one record: every record-scoped task action. */
const RHEA_ACTIONS: readonly Action[] = ['read', 'write', 'comment', 'assign', 'share'];

// eslint-disable-next-line max-lines-per-function -- one world, built in one place
export async function createIdentWorld(part: string): Promise<IdentWorld> {
  const h = await createHarness(part);
  const { world } = h;

  const person: PersonCall = async (caller, name, body, businessKey = 'alpha') =>
    await call(
      world.api,
      personPath(businessKey, pathOf(name)),
      { operationId: randomUUID(), ...body },
      bearer(caller.token),
    );

  const agent: AgentCall = async (identity, name, body, credential, businessKey = 'alpha') =>
    await call(
      world.api,
      agentPath(businessKey, pathOf(name)),
      { operationId: randomUUID(), ...body },
      credential === undefined
        ? bearer(identity.token)
        : { ...bearer(identity.token), [DELEGATION_HEADER]: credential },
    );

  async function taskOf(caller: Caller, title: string, businessKey: string): Promise<Task> {
    const created = await person(caller, 'task.create', { fields: { title } }, businessKey);
    need(created, 'task.create');
    return { id: String(created.body['recordId']), revision: Number(created.body['revision']) };
  }

  async function proposeAs(caller: Caller, title: string, businessKey: string): Promise<Proposed> {
    const task = await taskOf(caller, title, businessKey);
    const detail = need(
      await person(
        caller,
        'task.propose',
        { recordId: task.id, expectedRevision: task.revision, ...PROPOSAL },
        businessKey,
      ),
      'task.propose',
    );
    return {
      task,
      gateId: String(detail['gateId']),
      versionId: String(detail['versionId']),
      lineageId: String(detail['lineageId']),
    };
  }

  async function pickUpAs(
    caller: Caller,
    identity: AgentIdentity,
    title: string,
    businessKey: string,
  ): Promise<Picked> {
    const proposed = await proposeAs(caller, title, businessKey);
    const decided = need(
      await person(
        caller,
        'task.decide',
        {
          gateId: proposed.gateId,
          versionId: proposed.versionId,
          decision: 'approve',
          note: 'approved so an agent can work it',
        },
        businessKey,
      ),
      'task.decide',
    );
    const reservationId = String(decided['reservationId']);
    const picked = need(
      await agent(identity, 'task.pickup', { reservationId }, undefined, businessKey),
      'task.pickup',
    );
    const text = (key: string): string => String(picked[key]);
    return {
      taskId: text('taskId'),
      leaseId: text('leaseId'),
      fence: Number(picked['fence']),
      delegationId: text('delegationId'),
      credential: text('credential'),
      reservationId,
    } satisfies Picked;
  }

  // bravo's admin and agent, and bravo's work in flight.
  const bravoAdmin = await enrolCaller(world.db, world.bravo, 'bravo', 'bram', {
    membership: true,
    actions: ADMIN_ACTIONS,
    collections: ADMIN_COLLECTIONS,
  });
  const bravoAgent = await enrolAgent(world.db, world.bravo, bravoAdmin.actorId as string);
  const bravoTask = await taskOf(bravoAdmin, 'a bravo task alpha is handed', 'bravo');
  const bravoProposal = await proposeAs(bravoAdmin, 'a bravo proposal', 'bravo');
  const bravoPicked = await pickUpAs(bravoAdmin, bravoAgent, 'bravo agent work', 'bravo');
  const trashable = await taskOf(bravoAdmin, 'a bravo task in the trash', 'bravo');
  const trashBody = { recordId: trashable.id, expectedRevision: trashable.revision };
  const trashed = need(await person(bravoAdmin, 'task.trash', trashBody, 'bravo'), 'task.trash');
  const bravoGrants = await world.db.admin.execute<{ readonly id: string }>(
    `select id from public.grants
      where business_id = $1 and subject_kind = 'person' and subject_id = $2
        and revoked_at is null
      order by id limit 1`,
    [world.bravo, world.bea.personId],
  );

  // alpha's second agent, with a live lease of its own.
  const secondAgent = await enrolAgent(world.db, world.alpha, world.ada.actorId as string);
  const otherPicked = await pickUpAs(world.ada, secondAgent, 'the second agent’s work', 'alpha');

  // rhea: a member whose reach stops at one record.
  const rhea = await enrolCaller(world.db, world.alpha, 'alpha', 'rhea', {
    membership: true,
    actions: [],
    collections: [],
  });
  const rheaTask = await taskOf(world.ada, 'the one task rhea may reach', 'alpha');
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const { presented } = rhea;
    const member = {
      personId: rhea.personId as string,
      actorId: rhea.actorId as string,
      presented,
    };
    for (const action of RHEA_ACTIONS) {
      // eslint-disable-next-line no-await-in-loop -- a handful of grants, in order
      await grantTo(tx, member, action, { kind: 'record', id: rheaTask.id });
    }
  });

  return {
    h,
    foreign: {
      admin: bravoAdmin,
      task: bravoTask,
      proposal: bravoProposal,
      picked: bravoPicked,
      batchId: String(trashed['batchId']),
      grantId: String(bravoGrants[0]?.id),
    },
    otherPicked,
    rhea,
    rheaTask,
    person,
    agent,
    propose: async (title) => await proposeAs(world.ada, title, 'alpha'),
    pickUp: async (identity, title) => await pickUpAs(world.ada, identity, title, 'alpha'),
    close: async () => {
      await h.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Durable state and the audit chain, read on the administrative connection.
// ---------------------------------------------------------------------------

/** Evidence of attempts, which a committed refusal writes by contract (T1). */
const EVIDENCE_TABLES: ReadonlySet<string> = new Set([
  'audit_events',
  'operations',
  'authentication_attempts',
]);

/**
 * One digest per business over every other tenant table, every row, every
 * column. A refusal that moved anything (a revision, a lease's expiry, a
 * delegation's revocation stamp, a grant) changes it.
 */
export async function domainState(
  h: Harness,
  businessIds: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const admin = h.world.db.admin;
  const tables = await admin.execute<{ readonly table_name: string }>(
    `select distinct c.table_name from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'business_id'
        and t.table_type = 'BASE TABLE'
      order by c.table_name`,
  );
  const out: Record<string, string> = {};
  for (const businessId of businessIds) {
    const parts: string[] = [];
    for (const { table_name: table } of tables) {
      if (EVIDENCE_TABLES.has(table)) continue;
      // eslint-disable-next-line no-await-in-loop -- one table at a time, serially
      const rows = await admin.execute<{ readonly d: string }>(
        `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d
           from public.${table} t where t.business_id = $1`,
        [businessId],
      );
      parts.push(`${table}=${rows[0]?.d ?? ''}`);
    }
    out[businessId] = parts.join(';');
  }
  return out;
}

export type AuditRow = Readonly<
  Record<'business_id' | 'seq' | 'actor_id' | 'command' | 'outcome' | 'payload_digest', string> &
    Record<'operation_id' | 'refusal_code' | 'subject_record_id', string | null> & {
      attempted: unknown;
    }
>;

/** Where each business's chain stands, so a probe's own rows can be told apart. */
export async function auditMark(h: Harness): Promise<ReadonlyMap<string, bigint>> {
  const rows = await h.world.db.admin.execute<{ readonly business_id: string; readonly s: string }>(
    `select b.id as business_id, coalesce(max(a.seq), 0)::text as s
       from public.businesses b left join public.audit_events a on a.business_id = b.id
      group by b.id`,
  );
  return new Map(rows.map((row) => [row.business_id, BigInt(row.s)]));
}

/** Every audit row written in any business since `mark`. */
export async function auditSince(
  h: Harness,
  mark: ReadonlyMap<string, bigint>,
): Promise<readonly AuditRow[]> {
  const rows = await h.world.db.admin.execute<AuditRow>(
    `select business_id, seq::text as seq, actor_id, command, operation_id, outcome,
            refusal_code, subject_record_id::text as subject_record_id, payload_digest, attempted
       from public.audit_events order by business_id, seq`,
  );
  return rows.filter((row) => BigInt(row.seq) > (mark.get(row.business_id) ?? 0n));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The string values a body carries that are content rather than identity. */
function contentOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (!UUID.test(value) && value.length >= 4) out.push(value);
  } else if (Array.isArray(value)) {
    for (const one of value) contentOf(one, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const one of Object.values(value)) contentOf(one, out);
  }
  return out;
}

export interface AuditExpectation {
  readonly businessId: string;
  readonly actorId: string;
  readonly command: string;
  readonly operationId: string | null;
  readonly outcome: 'applied' | 'refused';
  readonly refusalCode: string | null;
  readonly body: Body;
}

/**
 * Exactly one row for this attempt, in the caller's own business and nowhere
 * else, naming who, what, which operation and how it ended, and carrying the
 * request only as a digest.
 */
export function expectAudited(
  label: string,
  rows: readonly AuditRow[],
  expected: AuditExpectation,
): void {
  const elsewhere = rows.filter((row) => row.business_id !== expected.businessId);
  expect(elsewhere, `${label}: audit outside the caller's business`).toStrictEqual([]);
  const own = rows.filter((row) => row.command === expected.command);
  expect(own, `${label}: audit rows for ${expected.command}`).toHaveLength(1);
  const row = own[0] as AuditRow;
  expect(
    {
      actor: row.actor_id,
      command: row.command,
      operation: row.operation_id,
      outcome: row.outcome,
      code: row.refusal_code,
    },
    label,
  ).toStrictEqual({
    actor: expected.actorId,
    command: expected.command,
    operation: expected.operationId,
    outcome: expected.outcome,
    code: expected.refusalCode,
  });
  expect(row.payload_digest, `${label}: digest`).toMatch(/^[0-9a-f]{64}$/u);
  expect(row.attempted, `${label}: attempted`).toBeNull();
  const stored = JSON.stringify(row);
  for (const content of contentOf(expected.body)) {
    expect(stored.includes(content), `${label}: audit row carries "${content}"`).toBe(false);
  }
}
