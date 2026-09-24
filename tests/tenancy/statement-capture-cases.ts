// SPDX-License-Identifier: AGPL-3.0-only
//
// What `statement-capture-full.test.ts` needs to drive every exported
// operation through an observed connection, and to read what it sent.
//
// It is a harness and not a suite, like `tests/acceptance/role-case-*.ts`: the
// cases are the matrix's own positive bodies (`role-case-bodies.ts`, by
// import), and what this file adds is the three things the matrix does not
// have — a second application over a logged connection, the five bodies the
// matrix records as exceptions because they need an agent's pickup, and a
// reading of one operation's statements into the shape T04 and M03 ask about.
//
// **Why a second application.** The matrix's world serves every call on
// `db.app`, including the setup a positive body needs first: the task a
// reopen completes, the proposal a decision decides. A capture of that
// connection would mix the setup's transactions with the operation's. So the
// setup runs through the world as the matrix runs it, and the one call under
// test runs through `createApi` built over `connect(..., { log, max: 1 })`,
// the same composition `world.ts` builds, on the same credentials. With one
// connection and one call at a time, what the log gained during the call is
// the call's and nothing else's.

import { randomUUID } from 'node:crypto';
import {
  pathOf,
  type CommandDeclaration,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createStatementLog,
  type RecordedStatement,
  type StatementLog,
} from '../../packages/core-records/src/tenancy/statements.ts';
import { createApi } from '../../apps/api/app.ts';
import { DELEGATION_HEADER } from '../../packages/core-records/src/commands/surface.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  ACCEPTANCE_SECRET,
  agentPath,
  bearer,
  call,
  personPath,
  type Answer,
  type World,
} from '../acceptance/world.ts';
import type { Harness } from '../acceptance/role-case-harness.ts';

/** Who sends the captured call, and on which prefix. */
export interface CapturedCall {
  readonly name: CommandName;
  readonly body: Readonly<Record<string, unknown>>;
  /** `person` is the person prefix with a bearer; `agent` the agent prefix. */
  readonly prefix: 'person' | 'agent';
  /** The bearer a person call presents. Absent means the admin, `ada`. */
  readonly token?: string;
  /** The delegation credential an agent call presents, after a pickup. */
  readonly credential?: string;
}

/** The application under capture, and the log it writes to. */
export interface Observed {
  readonly log: StatementLog;
  send(captured: CapturedCall): Promise<{ answer: Answer; sent: readonly RecordedStatement[] }>;
  close(): Promise<void>;
}

/**
 * The application `world.ts` builds, over a connection of its own with a log.
 *
 * `rebuildApi` is the same composition, but it opens its connection without a
 * log, so this is that function's body with the one option it lacks.
 */
export function observe(world: World): Observed {
  const log = createStatementLog();
  const database = connect(world.db.appUrl, { source: 'runtime', log, max: 1 });
  const byKey: Readonly<Record<string, string>> = { alpha: world.alpha, bravo: world.bravo };
  const api = createApi({
    database,
    verify: createSupabaseVerifier({ secret: ACCEPTANCE_SECRET }),
    resolveBusiness: async (key: string) => byKey[key],
    executeCommand,
    executeRead,
    executeAgentCommand,
  });
  return {
    log,
    async send(captured) {
      const from = log.entries.length;
      const path =
        captured.prefix === 'agent'
          ? agentPath('alpha', pathOf(captured.name))
          : personPath('alpha', pathOf(captured.name));
      const headers =
        captured.prefix === 'agent'
          ? {
              ...bearer(world.agent.token),
              ...(captured.credential === undefined
                ? {}
                : { [DELEGATION_HEADER]: captured.credential }),
            }
          : bearer(captured.token ?? world.ada.token);
      const answer = await call(
        api,
        path,
        { operationId: randomUUID(), ...captured.body },
        headers,
      );
      return { answer, sent: log.entries.slice(from) };
    },
    close: async () => {
      await database.close();
    },
  };
}

const oneLine = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();
const LOCAL_SETTING = `select set_config('app.business_id', $1, true)`;
const BEGIN = /^begin\b/iu;
/** `commit`, or a whole-transaction `rollback`; never `rollback to savepoint`. */
const END = /^(commit|rollback)\s*$/iu;
const WORK = /^(savepoint|release savepoint|rollback to savepoint) (command|agent)_work$/iu;

/**
 * One operation's statements, read into what T04 and M03 ask of them.
 *
 * It is an object rather than a list of assertions so that a failure prints
 * the whole shape next to the expected one, and so that the unit cases in the
 * suite can show each field catching the thing it is for.
 */
export interface Shape {
  /** Top-level transactions, from `begin` to `commit` or a whole `rollback`. */
  readonly transactions: number;
  /** Statements sent while no transaction was open. */
  readonly outside: readonly string[];
  /** The statement after each `begin`, which must be the local setting. */
  readonly afterBegin: readonly string[];
  /** How each transaction ended. */
  readonly ends: readonly string[];
  /** The work savepoint's statements, in order: the envelope's refusal mechanism. */
  readonly work: readonly string[];
  /** Anything the log cannot clear of changing the schema. */
  readonly schemaChanging: readonly string[];
  /** Any setting that outlives its transaction, or any `set`/`reset` at all. */
  readonly sessionWide: readonly string[];
  /**
   * Which trail the call wrote (I13: every operation, either outcome). A
   * refusal before any login resolves has no actor to audit, and the ledger
   * gives it to the separate authentication-attempt owner.
   */
  readonly audited: 'audit_events' | 'authentication_attempts' | 'none';
}

/**
 * The one statement the runtime connection sends outside a transaction.
 *
 * `postgres` 3.4.9 looks up the array types on the first query of every
 * physical connection (`fetch_types`, on by default; `src/connection.js:84`,
 * reset per connection at `:368`, the query at `:771`). It reads `pg_catalog`
 * and nothing of any business, and no application code can reach it: it is
 * the driver's, sent before the first `begin`. The suite sends one call before
 * the captured ones and asserts this is all that call sent outside its
 * transaction, rather than filtering it out of every capture.
 */
export const DRIVER_TYPE_LOOKUP: string =
  'select b.oid, b.typarray from pg_catalog.pg_type a left join pg_catalog.pg_type b ' +
  "on b.oid = a.typelem where a.typcategory = 'A' group by b.oid, b.typarray order by b.oid";

export function shapeOf(sent: readonly RecordedStatement[]): Shape {
  let open = false;
  let depth = 0;
  const outside: string[] = [];
  const afterBegin: string[] = [];
  const ends: string[] = [];
  let expectSetting = false;
  for (const entry of sent) {
    const text = oneLine(entry.text);
    if (expectSetting) {
      afterBegin.push(text);
      expectSetting = false;
    }
    if (BEGIN.test(text)) {
      if (open) outside.push(`nested: ${text}`);
      open = true;
      depth += 1;
      expectSetting = true;
      continue;
    }
    if (!open) outside.push(text);
    if (END.test(text)) {
      ends.push(text.toLowerCase());
      open = false;
    }
  }
  if (open) outside.push('unterminated transaction');
  return {
    transactions: depth,
    outside,
    afterBegin,
    ends,
    work: sent.map((entry) => oneLine(entry.text).toLowerCase()).filter((t) => WORK.test(t)),
    schemaChanging: sent
      .filter((entry) => entry.kind === 'ddl' || entry.kind === 'opaque')
      .map((entry) => `${entry.kind}: ${oneLine(entry.text)}`),
    sessionWide: sent
      .filter(
        (entry) =>
          entry.kind === 'session' ||
          /set_config\s*\(\s*'app\.business_id'[^)]*,\s*false\s*\)/iu.test(entry.text),
      )
      .map((entry) => oneLine(entry.text)),
    audited: sent.some((entry) => /^insert into (public\.)?audit_events\b/iu.test(entry.text))
      ? 'audit_events'
      : sent.some((entry) => /^insert into (public\.)?authentication_attempts\b/iu.test(entry.text))
        ? 'authentication_attempts'
        : 'none',
  };
}

/** The shape every captured operation must have, whatever its outcome. */
export function expectedShape(
  declaration: CommandDeclaration,
  prefix: CapturedCall['prefix'],
  outcome: 'applied' | 'refused' | 'unresolved',
): Shape {
  // The agent prefix runs its own envelope with its own savepoint name.
  const savepoint = prefix === 'agent' ? 'agent_work' : 'command_work';
  return {
    transactions: 1,
    outside: [],
    afterBegin: [LOCAL_SETTING],
    ends: ['commit'],
    // A read has no savepoint, and a login that resolves to no standing never
    // reaches the envelope that opens one.
    work:
      declaration.kind === 'read' || outcome === 'unresolved'
        ? []
        : [
            `savepoint ${savepoint}`,
            `${outcome === 'refused' ? 'rollback to' : 'release'} savepoint ${savepoint}`,
          ],
    schemaChanging: [],
    sessionWide: [],
    audited: outcome === 'unresolved' ? 'authentication_attempts' : 'audit_events',
  };
}

/** A body the matrix could not give, built here from the agent's own journey. */
export type AgentRecipe = (harness: Harness) => Promise<Omit<CapturedCall, 'name'>>;

/** A reservation an agent may pick up, decided by the admin through the routes. */
async function reservation(harness: Harness): Promise<string> {
  const { decided } = await harness.approvedReservation();
  if (decided.code !== 'ok') throw new Error(`capture: decide refused ${decided.code}`);
  return String((decided.body['detail'] as Record<string, unknown>)['reservationId']);
}

/**
 * The agent's live delegations, revoked through the route.
 *
 * The world has one agent and it holds one live delegation at a time: a second
 * pickup is refused `DELEGATION_ALREADY_LIVE`. The captured pickup leaves one
 * behind, so every recipe that needs a pickup of its own ends that one first,
 * through `delegation.revoke` on the world's application, as its setup.
 */
async function endLive(harness: Harness): Promise<void> {
  const { world } = harness;
  const live = await world.db.admin.execute<{ readonly id: string }>(
    `select id from public.delegations
      where business_id = $1 and agent_actor_id = $2
        and revoked_at is null and settled_at is null and expires_at > now()`,
    [world.alpha, world.agent.actorId],
  );
  for (const { id } of live) {
    // eslint-disable-next-line no-await-in-loop
    const revoked = await harness.asPerson('delegation.revoke', { delegationId: id });
    if (revoked.code !== 'ok')
      throw new Error(`capture: delegation.revoke refused ${revoked.code}`);
  }
}

/** A pickup on the world's application, so the captured call is only what follows it. */
async function pickedUp(harness: Harness): Promise<Record<string, unknown>> {
  await endLive(harness);
  const picked = await harness.asAgent('task.pickup', {
    reservationId: await reservation(harness),
  });
  if (picked.code !== 'ok') throw new Error(`capture: pickup refused ${picked.code}`);
  return picked.body['detail'] as Record<string, unknown>;
}

/**
 * The operations `role-case-bodies.ts` answers with an exception rather than a
 * body. Each is the positive call the matrix points elsewhere for, built from
 * the same journey its comment names. `task.pickup`, `task.heartbeat` and
 * `task.handback` left this list when person work became positive (EX-01):
 * the matrix now has a person body for each, and their agent calls are
 * captured separately below so the agent path stays covered.
 */
export const AGENT_RECIPES: Partial<Record<CommandName, AgentRecipe>> = {
  'delegation.revoke': async (harness) => {
    const picked = await pickedUp(harness);
    return { prefix: 'person', body: { delegationId: picked['delegationId'] } };
  },
  'grant.revoke': async (harness) => {
    // A grant of its own to take away, issued to `noah` so no other case
    // loses the authority it runs on. The revocation is the route.
    const { world } = harness;
    const grantId = await world.db.app.withBusiness(world.alpha, async (tx) => {
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: world.noah.personId as string },
        scope: { kind: 'business', id: null },
        collection: 'task',
        action: 'read',
        parentGrantId: null,
        grantedByActorId: world.ada.actorId as string,
      });
      if (!issued.ok) throw new Error(`capture: grant refused ${issued.refusal.code}`);
      return issued.value;
    });
    return { prefix: 'person', body: { grantId } };
  },
};

/**
 * The agent's own call for the operations a person now performs too. The
 * person body is the positive case above; these keep the agent prefix's
 * statement shape under the same capture, from the journey the matrix names.
 */
export const AGENT_PATH_RECIPES: Partial<Record<CommandName, AgentRecipe>> = {
  'task.pickup': async (harness) => {
    await endLive(harness);
    return { prefix: 'agent', body: { reservationId: await reservation(harness) } };
  },
  'task.heartbeat': async (harness) => {
    const picked = await pickedUp(harness);
    return {
      prefix: 'agent',
      body: { leaseId: picked['leaseId'], fence: picked['fence'] },
      credential: String(picked['credential']),
    };
  },
  'task.handback': async (harness) => {
    const picked = await pickedUp(harness);
    return {
      prefix: 'agent',
      body: {
        leaseId: picked['leaseId'],
        fence: picked['fence'],
        outcome: 'completed',
        report: { wrote: 'a draft' },
      },
      credential: String(picked['credential']),
    };
  },
};
