// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the identifier negatives and the per-operation audit proofs are
// driven against, and the questions both of them ask it.
//
// It is `role-case-harness.ts`'s world plus what ledger rows I03, I04 and
// I13 need beyond the matrix's one operand kind, the task record:
//
// - **bravo's own work in flight**, made through bravo's own routes and read
//   back from its rows: an admin, an agent, a task, a proposal, an approved
//   reservation, a live lease and delegation, a trash batch and a grant.
// - **a second alpha agent** with a live lease: another agent's lease is the
//   same-business identifier an agent may not reach.
// - **`rhea`**, whose task grants name one record, since an admin reaches all.
//
// Nothing below the boundary is substituted. Fixture grants go through
// `issueGrant` via `grantTo`; every probe goes through `callRaw`.

import { randomUUID } from 'node:crypto';
import { grantTo } from '../commands/fixture.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { ADMIN_ACTIONS, ADMIN_COLLECTIONS, enrolAgent, enrolCaller } from './cast.ts';
import { bravoRecords } from './ident-audit-bravo-rows.ts';
import { createHarness, type Harness } from './role-case-harness.ts';
import { PROPOSAL, type Task } from './role-case-bodies.ts';
import {
  agentPath,
  bearer,
  personPath,
  type AgentIdentity,
  type Answer,
  type Caller,
} from './world.ts';
import { logTime } from '../../packages/core-records/src/tasks/time.ts';

export type Body = Readonly<Record<string, unknown>>;

/** A pickup's answer: the handles an agent operand names. */
export type Picked = Readonly<
  Record<
    'taskId' | 'leaseId' | 'delegationId' | 'credential' | 'reservationId' | 'attemptId',
    string
  >
> & { readonly fence: number };
/** A proposal's handles. */
export type Proposed = Readonly<
  Record<'gateId' | 'versionId' | 'lineageId', string> & { task: Task }
>;

/** An answer and the exact bytes it arrived as (root ruling 2 compares those). */
export interface RawAnswer extends Answer {
  readonly text: string;
}

type PersonCall = (
  caller: { readonly token: string },
  name: CommandName,
  body: Body,
  businessKey?: string,
) => Promise<RawAnswer>;
type AgentCall = (
  identity: AgentIdentity,
  name: CommandName,
  body: Body,
  credential?: string,
  businessKey?: string,
) => Promise<RawAnswer>;

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
    /** A time entry of bravo's admin on bravo's task (MP-4-6). */
    entryId: string;
    legalVersionId: string;
    credentialId: string;
    clientId: string;
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

/** `world.ts` `call` with a fresh operation id, keeping the answer's text too. */
async function callRaw(
  api: Harness['world']['api'],
  path: string,
  body: Body,
  headers: Record<string, string>,
): Promise<RawAnswer> {
  const response = await api.fetch(
    new Request(`http://api.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ operationId: randomUUID(), ...body }),
    }),
  );
  const text = await response.text();
  // A fault answers in plain text; the status assertion reports it.
  const parsed: Record<string, unknown> = text.startsWith('{') ? JSON.parse(text) : { raw: text };
  const code = parsed['refused'] === true ? String(parsed['code']) : 'ok';
  return { status: response.status, body: parsed, code, text };
}

// eslint-disable-next-line max-lines-per-function -- one world, built in one place
export async function createIdentWorld(part: string): Promise<IdentWorld> {
  const h = await createHarness(part);
  const { world } = h;

  const person: PersonCall = async (caller, name, body, businessKey = 'alpha') =>
    await callRaw(world.api, personPath(businessKey, pathOf(name)), body, bearer(caller.token));

  const agent: AgentCall = async (identity, name, body, credential, businessKey = 'alpha') =>
    await callRaw(
      world.api,
      agentPath(businessKey, pathOf(name)),
      body,
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
      attemptId: text('attemptId'),
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
  const bravoEntry = await world.db.app.withBusiness(
    world.bravo,
    async (tx) =>
      await logTime(tx, {
        taskId: bravoTask.id,
        personId: bravoAdmin.personId as string,
        actorId: bravoAdmin.actorId as string,
        minutes: 5,
        note: 'a bravo entry alpha is handed',
      }),
  );
  if (bravoEntry.kind !== 'logged') throw new Error('ident-audit: bravo’s entry was not logged');
  const bravoGrants = await world.db.admin.execute<{ readonly id: string }>(
    `select id from public.grants
      where business_id = $1 and subject_kind = 'person' and subject_id = $2
        and revoked_at is null
      order by id limit 1`,
    [world.bravo, world.bea.personId],
  );

  // bravo's own legal version, agent credential and client (C81, API-2, C32).
  const bravoRows = await bravoRecords(world);

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
    const member = { ...rhea, personId: rhea.personId as string, actorId: rhea.actorId as string };
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
      entryId: bravoEntry.entryId,
      ...bravoRows,
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

// Durable state and the audit chain, read on the administrative connection.

/** Evidence of attempts, which a committed refusal writes by contract (T1). */
export const EVIDENCE_TABLES: ReadonlySet<string> = new Set([
  'audit_events',
  'operations',
  'authentication_attempts',
]);
