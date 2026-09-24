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
  insertPerson,
} from '../identity/fixture.ts';
import { installSpine } from '../commands/fixture.ts';
import type { AgentIdentity, Caller } from './cast.ts';
import {
  ACCEPTANCE_SECRET,
  ADMIN_ACTIONS,
  ADMIN_COLLECTIONS,
  MEMBER_ACTIONS,
  enrolAgent,
  enrolCaller,
  tokenFor,
} from './cast.ts';

// Re-exported so every proof keeps one import for the fixture. The cast lives
// next door for the per-file cap's sake, not because it is a separate concern.
export { ACCEPTANCE_SECRET, tokenFor } from './cast.ts';
export type { AgentIdentity, Caller } from './cast.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { InstalledTaskSpine } from '../../packages/core-records/src/tasks/install.ts';

/** The server this suite reaches. Absent means the proofs are skipped, loudly. */
export const serverUrl: string | undefined = databaseUrlFromEnvironment();

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

  const ada = await enrolCaller(db, alpha, 'alpha', 'ada', {
    membership: true,
    actions: ADMIN_ACTIONS,
    collections: ADMIN_COLLECTIONS,
  });
  const mia = await enrolCaller(db, alpha, 'alpha', 'mia', {
    membership: true,
    actions: MEMBER_ACTIONS,
    collections: ['task'],
  });
  const noah = await enrolCaller(db, alpha, 'alpha', 'noah', {
    membership: true,
    actions: [],
    collections: [],
  });
  const orphan = await enrolCaller(db, alpha, 'alpha', 'orphan', {
    membership: false,
    actions: [],
    collections: [],
  });
  const bea = await enrolCaller(db, bravo, 'bravo', 'bea', {
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
    executeCommand,
    executeRead,
    executeAgentCommand,
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
      executeCommand,
      executeRead,
      executeAgentCommand,
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

/**
 * R4: an external party of `alpha` (minimum contract 8.1), shaped as the seed
 * mints its external login.
 *
 * A person, an acting identity, a login and its mapping, and **no
 * membership**. It is not in `createWorld` because every proof there counts
 * alpha's people, and a sixth person would change answers that have nothing to
 * do with it. Nothing is shared here: a share is `shareRecord`'s to issue, and
 * a fixture that wrote the grant would be the one thing the proof must not
 * lean on. Until something is shared the login resolves to nothing at all.
 */
export async function enrolExternal(world: World): Promise<Caller> {
  const subject = `ext-${randomUUID()}`;
  const identity = await world.db.app.withBusiness(world.alpha, async (tx) => {
    const personId = await insertPerson(tx, 'ext');
    const actorId = await insertActor(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, world.ada.actorId as string);
    return { personId, actorId };
  });
  return {
    name: 'ext',
    businessKey: 'alpha',
    personId: identity.personId,
    actorId: identity.actorId,
    subject,
    presented: { provider: 'supabase', subject },
    token: await tokenFor(subject),
  };
}
