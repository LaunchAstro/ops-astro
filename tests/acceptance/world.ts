// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the acceptance proofs are driven against, and the one place that
// builds it.
//
// Every proof in this directory runs the **real** Hono application from
// `apps/api/app.ts`'s composition — the same `createApi` the server binds a
// port to, the same `executeRead`, the same `executeAgentCommand`, the same
// GoTrue-shaped verifier — against a **real** Postgres migrated from empty.
// What is not here is a network: the app is driven through `app.fetch`, which
// is the boundary a caller reaches and not a shortcut past it.
//
// Three decisions this file makes, because a proof is only worth what its
// fixture is worth.
//
// **Nothing is substituted below the boundary.** `tests/api/boundary.test.ts`
// stubs the database on purpose: its questions are the transport's. The
// questions here are the opposite half — whether a foreign read really
// refuses, whether a protected field really does not move — so a stub would
// make every case below unfalsifiable.
//
// **The tokens are minted here rather than by GoTrue.** `createSupabaseVerifier`
// verifies an HS256 bearer against a deployment secret; a token this file signs
// with that same secret is the same token as far as every line of product code
// is concerned, and it keeps the suite in-process with no auth container to
// depend on. The subject is what identity resolution reads, and the subject is
// a real row in `logins`.
//
// **The cast is `scripts/local-seed.mjs`'s cast**, by name and by role: `ada`,
// `mia`, `noah`, `orphan` and `bea`, with `noah` holding a membership and no
// grant and `orphan` a verified login with no membership at all. The seed is
// not imported — it needs GoTrue and it writes into the running slice's own
// database — but its shape is followed so that a case proved here is a case
// about the product a person actually signs into.

import { randomUUID } from 'node:crypto';
import { sign } from 'hono/jwt';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { grantTo, installSpine, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { createApi, type AgentExecutor, type ReadExecutor } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { BusinessId, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import type { InstalledTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';

/** The deployment secret for this suite. Local, disposable, never a real one. */
export const ACCEPTANCE_SECRET = 'l5-acceptance-secret-not-any-running-deployment';

/** The server this suite reaches. Absent means the proofs are skipped, loudly. */
export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export interface Caller {
  /** The name the seed gives them, which is the name the matrix prints. */
  readonly name: string;
  readonly businessKey: string;
  readonly personId: string | null;
  readonly actorId: string | null;
  readonly subject: string;
  readonly presented: VerifiedSubject;
  /** A signed bearer for this subject, already minted. */
  readonly token: string;
}

export interface AgentIdentity {
  readonly subject: string;
  readonly presented: VerifiedSubject;
  readonly actorId: string;
  readonly token: string;
}

export interface World {
  readonly db: FreshDatabase;
  readonly alpha: BusinessId;
  readonly bravo: BusinessId;
  readonly spineAlpha: InstalledTaskSpine;
  readonly spineBravo: InstalledTaskSpine;
  readonly ada: Caller;
  readonly mia: Caller;
  readonly noah: Caller;
  readonly orphan: Caller;
  readonly bea: Caller;
  readonly agent: AgentIdentity;
  /** The real application, built the way `apps/api/server.ts` builds it. */
  readonly api: ReturnType<typeof createApi>;
  close(): Promise<void>;
}

/**
 * The grants each seeded role holds, copied from `GRANTS_BY_ROLE` in the seed.
 *
 * `noah` is absent on purpose and that absence is the whole of case N2: a
 * member with no grant must be told `SCOPE_NOT_GRANTED` and never handed an
 * empty list, and a fixture that quietly granted him something would have
 * turned that case into a tautology.
 */
const ADMIN_ACTIONS: readonly Action[] = [
  'read',
  'write',
  'assign',
  'comment',
  'decide',
  'share',
  'manage',
];
const MEMBER_ACTIONS: readonly Action[] = ['read', 'write', 'assign', 'comment'];

/**
 * The collections an administrator holds authority over.
 *
 * `task` is not the whole surface any more. `person.list` asks about `person`,
 * the two settings commands about `settings`, and `preset.plan` about the
 * record family it names — so an administrator granted only on tasks is
 * refused `SCOPE_NOT_GRANTED` on four declarations, and a matrix built on that
 * fixture would have recorded four missing positive controls as product
 * failures. The grant is per collection because the surface says it is.
 */
const ADMIN_COLLECTIONS: readonly string[] = ['task', 'person', 'settings', 'preset'];

export async function tokenFor(
  subject: string,
  options: { readonly expiresIn?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await sign(
    {
      sub: subject,
      aud: 'authenticated',
      role: 'authenticated',
      exp: now + (options.expiresIn ?? 3600),
    },
    ACCEPTANCE_SECRET,
    'HS256',
  );
}

async function enrolCaller(
  world: Pick<World, 'db'>,
  businessId: BusinessId,
  businessKey: string,
  name: string,
  options: {
    readonly membership: boolean;
    readonly actions: readonly Action[];
    readonly collections: readonly string[];
  },
): Promise<Caller> {
  const subject = `${name}-${randomUUID()}`;
  const identity = await world.db.app.withBusiness(businessId, async (tx) => {
    const personId = await insertPerson(tx, name);
    const actorId = await insertActor(tx, personId);
    // A login with no membership is `orphan`: verified by the provider, known
    // to no business, which is `AUTH_NO_MEMBERSHIP` and not `AUTH_UNKNOWN_LOGIN`.
    if (options.membership) await insertMembership(tx, personId);
    const loginId = await insertLogin(tx, subject);
    await insertMapping(tx, loginId, personId, actorId);
    return { personId, actorId };
  });
  const member = { ...identity, presented: { provider: 'supabase', subject } as VerifiedSubject };
  if (options.actions.length > 0) {
    await world.db.app.withBusiness(businessId, async (tx: TenantQuery) => {
      for (const collection of options.collections) {
        for (const action of options.actions) {
          // eslint-disable-next-line no-await-in-loop -- one grant at a time reads as a list
          await grantTo(tx, member, action, WHOLE_BUSINESS, false, collection);
        }
      }
    });
  }
  return {
    name,
    businessKey,
    personId: identity.personId,
    actorId: identity.actorId,
    subject,
    presented: member.presented,
    token: await tokenFor(subject),
  };
}

/**
 * The agent identity, written the way `scripts/local-seed.mjs` writes it: an
 * actor of kind `agent`, a login of its own, and a row in `actor_logins` and in
 * neither person table. The address is built rather than written out, which is
 * also what keeps it out of `scripts/public-content-check.mjs`'s way.
 */
async function enrolAgent(
  db: FreshDatabase,
  businessId: BusinessId,
  linkedBy: string,
): Promise<AgentIdentity> {
  const subject = ['agent', randomUUID()].join('-');
  const actorId = randomUUID();
  await db.app.withBusiness(businessId, async (tx) => {
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      businessId,
      actorId,
    ]);
    const loginId = await insertLogin(tx, subject);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [businessId, randomUUID(), loginId, actorId, linkedBy],
    );
  });
  return {
    subject,
    presented: { provider: 'supabase', subject },
    actorId,
    token: await tokenFor(subject),
  };
}

/**
 * Build the world.
 *
 * `part` names the throwaway database so a run that leaves one behind says
 * which proof left it.
 */
export async function createWorld(part: string): Promise<World> {
  process.env['GATE_SIGNING_KEY_ID'] ??= `test/acceptance@1`;
  process.env['GATE_SIGNING_SECRET'] ??= randomUUID();

  const db = await createFreshDatabase({ part });
  const alpha = (await insertBusiness(db.app, 'alpha')) as BusinessId;
  const bravo = (await insertBusiness(db.app, 'bravo')) as BusinessId;
  const spineAlpha = await installSpine(db.app, alpha);
  const spineBravo = await installSpine(db.app, bravo);

  // The named settings rows. `installTaskSpine` does not write them and
  // `scripts/local-seed.mjs` does, so a fixture without them answers
  // `NOT_FOUND` for both `settings.*` commands for a reason that has nothing
  // to do with authority — and a matrix built on that would have recorded two
  // missing positive controls as product failures. Installing is additive, so
  // a second install by a caller's own harness resets nothing.
  for (const businessId of [alpha, bravo]) {
    // eslint-disable-next-line no-await-in-loop
    await db.app.withBusiness(businessId, async (tx) => {
      await installBusinessSettings(tx);
    });
  }

  const ada = await enrolCaller({ db }, alpha, 'alpha', 'ada', {
    membership: true,
    actions: ADMIN_ACTIONS,
    collections: ADMIN_COLLECTIONS,
  });
  const mia = await enrolCaller({ db }, alpha, 'alpha', 'mia', {
    membership: true,
    actions: MEMBER_ACTIONS,
    collections: ['task'],
  });
  const noah = await enrolCaller({ db }, alpha, 'alpha', 'noah', {
    membership: true,
    actions: [],
    collections: [],
  });
  const orphan = await enrolCaller({ db }, alpha, 'alpha', 'orphan', {
    membership: false,
    actions: [],
    collections: [],
  });
  const bea = await enrolCaller({ db }, bravo, 'bravo', 'bea', {
    membership: true,
    actions: MEMBER_ACTIONS,
    collections: ['task'],
  });
  const agent = await enrolAgent(db, alpha, ada.actorId as string);

  // The spending cap the reservation path reads. The seed writes one per
  // business; without it a proposal has no envelope to draw against.
  for (const businessId of [alpha, bravo]) {
    // eslint-disable-next-line no-await-in-loop
    await db.app.withBusiness(businessId, async (tx) => {
      await tx.query(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'local', 500000, 'AUD')`,
        [businessId, randomUUID()],
      );
    });
  }

  const byKey: Readonly<Record<string, BusinessId>> = { alpha, bravo };
  const api = createApi({
    database: db.app,
    verify: createSupabaseVerifier({ secret: ACCEPTANCE_SECRET }),
    // The server resolves the key on the administrative connection because the
    // tenancy root is behind forced row security. Two keys are the whole map
    // here, and an unknown key answers nothing, exactly as the server's does.
    resolveBusiness: async (key: string) => byKey[key],
    executeRead: executeRead as unknown as ReadExecutor,
    executeAgentCommand: executeAgentCommand as unknown as AgentExecutor,
  });

  return {
    db,
    alpha,
    bravo,
    spineAlpha,
    spineBravo,
    ada,
    mia,
    noah,
    orphan,
    bea,
    agent,
    api,
    close: async () => {
      await db.drop();
    },
  };
}

/**
 * A second application instance over the same database.
 *
 * "A fresh app instance" has to mean a genuinely new one or the restart proof
 * is a proof about a cache. This opens a new connection pool from the same
 * credentials and builds a new `createApi` around it, so nothing the first
 * instance held in memory — a resolved business, a pooled backend, a verifier
 * — carries across. The caller closes it.
 */
export function rebuildApi(world: World): {
  readonly api: ReturnType<typeof createApi>;
  close(): Promise<void>;
} {
  const database = connect(world.db.appUrl, { source: 'runtime' });
  const byKey: Readonly<Record<string, BusinessId>> = {
    alpha: world.alpha,
    bravo: world.bravo,
  };
  return {
    api: createApi({
      database,
      verify: createSupabaseVerifier({ secret: ACCEPTANCE_SECRET }),
      resolveBusiness: async (key: string) => byKey[key],
      executeRead: executeRead as unknown as ReadExecutor,
      executeAgentCommand: executeAgentCommand as unknown as AgentExecutor,
    }),
    close: async () => {
      await database.close();
    },
  };
}

export interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** The refusal code, or `ok` when the answer was a success. */
  readonly code: string;
}

/**
 * Drive the real app the way a caller does.
 *
 * The body is read as text first and parsed after: a fault and a missing route
 * answer in plain text, and a helper that could only read JSON would report
 * those as its own failure rather than as the status being asked about.
 */
export async function call(
  api: ReturnType<typeof createApi>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const response = await api.fetch(
    new Request(`http://api.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    parsed = { raw: text };
  }
  const code = parsed['refused'] === true ? String(parsed['code']) : 'ok';
  return { status: response.status, body: parsed, code };
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/** The person prefix and the agent prefix, spelled once. */
export const personPath = (businessKey: string, path: string): string =>
  `/api/b/${businessKey}${path}`;
export const agentPath = (businessKey: string, path: string): string =>
  `/api/a/b/${businessKey}${path}`;
