// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's bootstrap: the first business and its owner, made once. The
// decisions are here; `production-bootstrap.mjs` runs them.
//
// Before it connects it refuses, by setting name, an admin address on
// staging's project or on any project but production's, or one that does not
// require TLS. On the database, in one transaction, it refuses when any
// business is already there; otherwise it writes the business, its owner's
// person, actor, login and admin membership, the local seed's admin grants
// plus the operator's `operations:manage`, the operating business and the installation's operator.
// Every value is the operator's: no made-up row, no seed mark. The
// installation mode stays as the migrations leave it (0058). The owner's
// sign-in is made first through the provider's admin API, and its id is
// `--owner-subject` (deploy/production/README.md).

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { issueGrant, type Action } from '../../packages/core-records/src/authority/grants.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import type {
  AdminConnection,
  TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { databaseProject, projectRefs, Refusal } from './staging-reset.ts';

export interface Owner {
  readonly businessKey: string;
  readonly businessName: string;
  readonly ownerName: string;
  /** The provider's id for the owner's sign-in, made before this runs. */
  readonly ownerSubject: string;
}

/**
 * The local seed's admin grants (`scripts/local-seed-roles.ts`, `GRANTS_BY_ROLE.admin`,
 * in its order; a test holds the two equal), then the operator's one grant
 * (`staging-reset.ts`).
 */
export const OWNER_GRANTS: readonly (readonly [string, Action])[] = [
  ['task', 'read'],
  ['task', 'write'],
  ['task', 'assign'],
  ['task', 'comment'],
  ['task', 'share'],
  ['task', 'manage'],
  ['person', 'read'],
  ['settings', 'manage'],
  ['task', 'decide'],
  ['gate', 'decide'],
  ['settings', 'read'],
  ['billing', 'decide'],
  ['custody', 'manage'],
  ['connection', 'read'],
  ['finance', 'read'],
  ['mandate', 'manage'],
  ['conversation', 'write'],
  ['run', 'write'],
  ['access', 'share'],
  ['time', 'write'],
  ['tag', 'write'],
  ['access', 'manage'],
  ['operations', 'read'],
  ['privacy', 'manage'],
  ['credential', 'write'],
  ['record', 'write'],
  ['spend', 'decide'],
  ['chat', 'comment'],
  ['chat', 'manage'],
  ['automation', 'manage'],
  ['review', 'write'],
  ['review', 'read'],
  ['review', 'comment'],
  ['operations', 'manage'],
];

type Environment = Readonly<Record<string, string | undefined>>;
const FACTS = ['business-key', 'business-name', 'owner-name', 'owner-subject'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TLS_MODES: ReadonlySet<string> = new Set(['require', 'verify-ca', 'verify-full']);

function ownerFrom(args: readonly string[]): Owner {
  let values: Partial<Record<(typeof FACTS)[number], string>>;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: Object.fromEntries(FACTS.map((fact) => [fact, { type: 'string' }])),
      strict: true,
    }) as { values: typeof values });
  } catch {
    throw new Refusal(`name the business and its owner: --${FACTS.join(', --')}`);
  }
  const [businessKey = '', businessName = '', ownerName = '', ownerSubject = ''] = FACTS.map(
    (fact) => {
      const value = values[fact]?.trim() ?? '';
      if (value === '') throw new Refusal(`--${fact} is not set`);
      return value;
    },
  );
  if (!UUID.test(ownerSubject)) throw new Refusal('--owner-subject is not a sign-in id');
  return { businessKey, businessName, ownerName, ownerSubject };
}

/** The owner to make, or the refusal made before connecting, named by setting and never by value. */
export function bootstrapInput(
  environment: Environment,
  args: readonly string[],
): { owner: Owner } | { refusal: string } {
  try {
    const owner = ownerFrom(args);
    const { ref, otherRef } = projectRefs(environment, true);
    const adminUrl = environment['DATABASE_ADMIN_URL'] ?? '';
    if (adminUrl === '') throw new Refusal('DATABASE_ADMIN_URL is not set');
    const project = databaseProject('DATABASE_ADMIN_URL', adminUrl);
    if (project === otherRef) throw new Refusal("DATABASE_ADMIN_URL reaches staging's project");
    if (project !== ref) throw new Refusal("DATABASE_ADMIN_URL is not production's project");
    // Named once: postgres.js takes the last of a repeated parameter, this the first.
    const query = new URL(adminUrl).searchParams;
    const modes = query.getAll('sslmode');
    if (modes.length !== 1 || !TLS_MODES.has(modes[0] ?? '') || query.has('ssl'))
      throw new Refusal(
        'DATABASE_ADMIN_URL does not require TLS (add ?sslmode=require or stricter)',
      );
    return { owner };
  } catch (error) {
    if (error instanceof Refusal) return { refusal: error.message };
    throw error;
  }
}

/** The owner's person, acting identity, login and admin membership, in the business `tx` is in. */
async function makeOwner(tx: TenantQuery, owner: Owner): Promise<void> {
  const [personId, actorId, loginId] = [randomUUID(), randomUUID(), randomUUID()];
  const { businessId } = tx;
  await tx.query('insert into public.people (business_id, id, display_name) values ($1, $2, $3)', [
    businessId,
    personId,
    owner.ownerName,
  ]);
  await tx.query(
    `insert into public.actors (business_id, id, kind, person_id, active)
     values ($1, $2, 'person', $3, true)`,
    [businessId, actorId, personId],
  );
  await tx.query(
    `insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'supabase', $3)`,
    [businessId, loginId, owner.ownerSubject],
  );
  await tx.query(
    `insert into public.person_logins (business_id, id, login_id, person_id, active, linked_by_actor_id)
     values ($1, $2, $3, $4, true, $5)`,
    [businessId, randomUUID(), loginId, personId, actorId],
  );
  await tx.query(
    `insert into public.memberships (business_id, id, person_id, role_key, active)
     values ($1, $2, $3, 'admin', true)`,
    [businessId, randomUUID(), personId],
  );
  for (const [collection, action] of OWNER_GRANTS) {
    // One transaction, one connection: the grants go in one at a time.
    // oxlint-disable-next-line no-await-in-loop
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: personId },
      scope: { kind: 'business', id: null },
      collection,
      action,
      parentGrantId: null,
      grantedByActorId: actorId,
    });
    if (!issued.ok) throw new Refusal(`the grant ${collection}:${action} was refused`);
  }
}

/** The first business and its owner, in one transaction; refused when any business exists. */
export async function bootstrap(
  admin: AdminConnection,
  owner: Owner,
): Promise<{ businessId: string; grants: number }> {
  return await admin.transaction(async (execute) => {
    // Held to commit, so a second run waits and then finds this one's business.
    await execute('lock table public.businesses in exclusive mode');
    const [found] = await execute<{ n: number }>(
      'select count(*)::int as n from public.businesses',
    );
    if (found?.n !== 0) throw new Refusal('a business already exists');

    const businessId = randomUUID();
    await execute(
      'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)',
      [businessId, owner.businessKey, owner.businessName],
    );
    await execute('update ops.installation set operator_business_id = $1', [businessId]);
    await execute('insert into ops.operating_business (operating_business) values ($1)', [
      businessId,
    ]);
    // As `withBusiness` sets it, for the installers and the owner's rows.
    await execute(`select set_config('app.business_id', $1, true)`, [businessId]);
    const tx: TenantQuery = {
      businessId,
      query: <Row>(text: string, parameters?: readonly unknown[]) => execute<Row>(text, parameters),
    };
    await installTaskSpine(tx);
    await installBusinessSettings(tx);
    await makeOwner(tx, owner);
    return { businessId, grants: OWNER_GRANTS.length };
  });
}
