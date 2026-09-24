// SPDX-License-Identifier: AGPL-3.0-only
//
// A composition root a test can build twice, over a real database.
//
// `boundary.test.ts` substitutes the database because its questions are the
// transport's. The cases beside it ask the opposite question — whether the
// proposal-to-handback journey really runs over HTTP — so nothing here is a
// substitute except the port: the database is a throwaway one migrated from
// empty, the tokens are real HS256 bearers the real Supabase adapter verifies,
// the reads go through `reads/execute.ts` and the agent prefix through
// `commands/agent-envelope.ts`.
//
// **The composition root is the server's own.** `compose` calls `composeApi`
// from `apps/api/server.ts`, the wiring the server listens with, so there is
// no copy here to drift from it. Importing that file starts nothing: its
// `main` runs only as the process's entry. `composeApi` is a function, so
// calling it twice is two composition roots over one database, each with an
// empty resolver cache, which is the restart the journey case needs.

import { randomUUID } from 'node:crypto';
import { sign } from 'hono/jwt';
import type { Hono } from 'hono';
import {
  createFreshDatabase,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { composeApi } from '../../apps/api/server.ts';

/**
 * The business key to its identifier, on the administrative connection: the
 * server's own resolver, re-exported for the cases that build a boundary
 * around a second connection.
 */
export { createBusinessResolver } from '../../apps/api/server.ts';

/** The HS256 secret this deployment's GoTrue would sign with. Local to the run. */
export const SECRET = 'a-local-test-secret-for-the-api-journey-cases';

/** The key the path names the business by, which the server resolves itself. */
export const BUSINESS_KEY = 'alpha';

/** The cap an approval draws on. Large enough that nothing here exhausts it. */
const CAP_LIMIT_MINOR = 500_000;

/** The two gate values a decision needs, as a deployment's environment holds them. */
export interface GateEnvironment {
  readonly GATE_SIGNING_KEY_ID: string;
  readonly GATE_SIGNING_SECRET: string;
}

export interface ApiFixture {
  readonly db: FreshDatabase;
  readonly business: BusinessId;
  /** A person with read, write, decide, assign and comment on the whole business. */
  readonly member: Member;
  /** An agent actor with a login of its own and no row in `person_logins`. */
  readonly agent: VerifiedSubject;
  readonly agentActorId: string;
  /**
   * The deployment's environment, as `localEnvironment()` assembles one. A
   * second composition root reads this again rather than remembering what the
   * first one did with it.
   */
  readonly environment: GateEnvironment;
  /** A composition root from `composeApi`: a fresh boundary, resolver cache and gate read. */
  compose(): Hono;
  drop(): Promise<void>;
}

/**
 * A bearer the real adapter verifies, for the subject a login row carries.
 *
 * `expiresIn` is a signed offset so a case can mint one that has already run
 * out, which is the only way to reach `AUTH_SESSION_EXPIRED` honestly.
 */
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
      exp: now + (options.expiresIn ?? 600),
    },
    SECRET,
    'HS256',
  );
}

export interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * A POST through the mounted app, reading the answer as text first.
 *
 * A missing route and a fault both answer in plain text, and a helper that
 * could only read JSON would report those as its own failure rather than as
 * the status the case was asking about.
 */
export async function post(
  api: Hono,
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
  return { status: response.status, body: parsed };
}

export const authorised = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/**
 * A migrated database, a business, a person who may work, an agent identity,
 * a budget cap, and a `compose` that builds the boundary the way the server
 * does.
 */
export async function createApiFixture(part: string): Promise<ApiFixture> {
  const environment: GateEnvironment = {
    GATE_SIGNING_KEY_ID: `test/api-journey@${part}`,
    GATE_SIGNING_SECRET: randomUUID(),
  };

  const db = await createFreshDatabase({ part });
  const business = (await insertBusiness(db.app, BUSINESS_KEY)) as BusinessId;
  await installSpine(db.app, business);
  const member = await enrol(db.app, business, 'decider');

  let agent: VerifiedSubject = { provider: 'supabase', subject: '' };
  let agentActorId = '';
  await db.app.withBusiness(business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // Sequential: `issueGrant` reads the granter's own rows, so two at once
      // would interleave those reads.
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, member, action);
    }
    await tx.query(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'local', $3, 'AUD')`,
      [business, randomUUID(), CAP_LIMIT_MINOR],
    );
    // The agent identity a seed installs: an `agent` actor, a login of its own,
    // and a mapping in `actor_logins` and in neither person table.
    agentActorId = randomUUID();
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      business,
      agentActorId,
    ]);
    const subject = `agent-${randomUUID()}`;
    const loginId = await insertLogin(tx, subject);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [business, randomUUID(), loginId, agentActorId, member.actorId],
    );
    agent = { provider: 'supabase', subject };
  });

  return {
    db,
    business,
    member,
    agent,
    agentActorId,
    environment,
    compose(): Hono {
      // `server.ts` turns the deployment's gate file into a process fact before
      // it builds the boundary, because `commands/runtime-config.ts` reads
      // `process.env` rather than taking the key through every caller. A second
      // instance does it again from the same environment, which is what makes
      // "re-read from `process.env`" a step and not an assumption.
      process.env['GATE_SIGNING_KEY_ID'] = environment.GATE_SIGNING_KEY_ID;
      process.env['GATE_SIGNING_SECRET'] = environment.GATE_SIGNING_SECRET;
      return composeApi({
        database: db.app,
        admin: db.admin,
        secret: SECRET,
        executeRead,
      }).app;
    },
    async drop(): Promise<void> {
      await db.drop();
    },
  };
}
