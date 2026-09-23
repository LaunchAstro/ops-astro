// SPDX-License-Identifier: AGPL-3.0-only
//
// Default deny, read from the catalogue: who may reach a table, execute a
// function or build in a schema.
//
// The tenancy conformance set next door says the rows a reader is allowed to
// see are filtered. This says who gets to ask at all, which is the layer under
// it. Row security is the second barrier, not the first: a role with no
// privilege on a table never reaches a policy, and a privilege granted to
// PUBLIC hands every future role on the cluster whatever the grant said.
//
// Two rules here are not "no grants exist" and are worth saying out loud.
//
// - TRUNCATE is not filtered by row security. A role holding it empties every
//   tenant's rows in one statement and no policy is consulted. So the
//   application role must never hold it, even though it holds DELETE.
// - CREATE on a schema is what makes runtime DDL a server refusal rather than
//   a convention, and the migrations' own `revoke create` only covers the
//   schemas that existed when they ran.
//
// Like the conformance set, every check returns findings rather than throwing,
// and reads the catalogue rather than the text of a migration.

import type { AdminConnection } from './database.ts';
import type { Finding } from './conformance.ts';

type Read = AdminConnection['execute'];

/** The three separated roles a migration prefix is proved against. */
export interface StorageRoles {
  /** Owns the schema. Migrations run as this one. */
  readonly owner: string;
  /** The group role the migrations grant to. The application is a member. */
  readonly application: string;
  /** A login that is a member of nothing. It must reach nothing. */
  readonly restricted: string;
}

/** The schemas this installation owns. `pg_*` and information_schema are the server's. */
const OWN_SCHEMAS = `select nspname from pg_namespace
   where nspname not like 'pg\\_%' and nspname <> 'information_schema'`;

const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

interface RelationRow {
  readonly schema: string;
  readonly name: string;
  readonly granted: readonly string[] | null;
}

interface FunctionRow {
  readonly schema: string;
  readonly signature: string;
  readonly definer: boolean;
  readonly granted: readonly string[] | null;
}

interface SchemaRow {
  readonly nspname: string;
  readonly granted: readonly string[] | null;
}

/**
 * Every relation in the installation's own schemas, with the privileges one
 * role holds on it. Asked per role rather than per grant, because a role can
 * hold a privilege through membership in another role and `aclitem` alone
 * does not say so.
 */
async function relationsFor(read: Read, role: string): Promise<readonly RelationRow[]> {
  return await read<RelationRow>(
    `select n.nspname as schema, c.relname as name,
            (select array_agg(p) from unnest($2::text[]) as p
              where has_table_privilege($1, c.oid, p)) as granted
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
      order by 1, 2`,
    [role, [...TABLE_PRIVILEGES]],
  );
}

async function functionsFor(read: Read, role: string): Promise<readonly FunctionRow[]> {
  return await read<FunctionRow>(
    `select n.nspname as schema, p.oid::regprocedure::text as signature,
            p.prosecdef as definer,
            (select array_agg(x) from unnest(array['EXECUTE']) as x
              where has_function_privilege($1, p.oid, 'EXECUTE')) as granted
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
      order by 1, 2`,
    [role],
  );
}

async function schemasFor(
  read: Read,
  role: string,
  privilege: string,
): Promise<readonly SchemaRow[]> {
  return await read<SchemaRow>(
    `select nspname,
            (select array_agg(p) from unnest(array[$2::text]) as p
              where has_schema_privilege($1, nspname, p)) as granted
       from (${OWN_SCHEMAS}) as own
      order by 1`,
    [role, privilege],
  );
}

function held(granted: readonly string[] | null): readonly string[] {
  return granted ?? [];
}

/** Nothing at all, for a role that is meant to reach nothing. */
async function reachesNothing(read: Read, role: string, rule: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for (const relation of await relationsFor(read, role)) {
    const privileges = held(relation.granted);
    if (privileges.length > 0) {
      findings.push({
        rule,
        object: `${relation.schema}.${relation.name}`,
        detail: `${role} holds ${privileges.join(', ')}`,
      });
    }
  }
  for (const routine of await functionsFor(read, role)) {
    if (held(routine.granted).length > 0) {
      findings.push({
        rule,
        object: `${routine.schema}.${routine.signature}`,
        detail: `${role} may execute it${routine.definer ? ', and it runs as its definer' : ''}`,
      });
    }
  }
  return findings;
}

/**
 * The default-deny set. It is run after every migration prefix, so a prefix
 * that opens something a later migration closes again is still a failure:
 * an installation stopped between two migrations is a real state, and it is
 * the state a half-finished deploy leaves behind.
 */
export async function defaultDenyConformance(
  read: Read,
  roles: StorageRoles,
): Promise<readonly Finding[]> {
  const findings: Finding[] = [];

  findings.push(
    ...(await reachesNothing(
      read,
      'public',
      'no privilege is granted to PUBLIC, which is every role there will ever be',
    )),
  );
  findings.push(
    ...(await reachesNothing(
      read,
      roles.restricted,
      'a role outside the application group reaches no table and no function',
    )),
  );

  for (const schema of await schemasFor(read, roles.application, 'CREATE')) {
    if (held(schema.granted).length > 0) {
      findings.push({
        rule: 'the application role may create nothing, in any schema',
        object: schema.nspname,
        detail: `${roles.application} holds CREATE`,
      });
    }
  }
  for (const schema of await schemasFor(read, 'public', 'CREATE')) {
    if (held(schema.granted).length > 0) {
      findings.push({
        rule: 'the application role may create nothing, in any schema',
        object: schema.nspname,
        detail: 'PUBLIC holds CREATE',
      });
    }
  }

  // TRUNCATE empties a table without consulting a single row policy.
  for (const relation of await relationsFor(read, roles.application)) {
    const privileges = held(relation.granted);
    if (privileges.includes('TRUNCATE')) {
      findings.push({
        rule: 'the application role never holds TRUNCATE, which row security does not filter',
        object: `${relation.schema}.${relation.name}`,
        detail: `${roles.application} holds ${privileges.join(', ')}`,
      });
    }
  }

  // Ownership, not only grants. An owner may drop and recreate what it owns,
  // and `revoke` said to a table's owner changes nothing. The separation is
  // only real if the roles the application connects as own none of it.
  const owned = await read<{
    readonly schema: string;
    readonly name: string;
    readonly owner: string;
  }>(
    `select n.nspname as schema, c.relname as name, pg_get_userbyid(c.relowner) as owner
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and pg_get_userbyid(c.relowner) = any($1::text[])
      order by 1, 2`,
    [[roles.application, roles.restricted]],
  );
  for (const relation of owned) {
    findings.push({
      rule: 'the owner is separate: no table is owned by a role the application connects as',
      object: `${relation.schema}.${relation.name}`,
      detail: `owned by ${relation.owner}, not by ${roles.owner}`,
    });
  }

  const roleRows = await read<{
    readonly rolname: string;
    readonly rolsuper: boolean;
    readonly rolbypassrls: boolean;
  }>(`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = any($1::text[])`, [
    [roles.application, roles.restricted],
  ]);
  for (const row of roleRows) {
    if (row.rolsuper || row.rolbypassrls) {
      findings.push({
        rule: 'no application-side role is superuser or bypasses row security',
        object: row.rolname,
        detail: `superuser ${String(row.rolsuper)}, bypassrls ${String(row.rolbypassrls)}`,
      });
    }
  }

  return findings;
}

/**
 * What the installation actually stores things in, so "storage is denied by
 * default" is answered with a catalogue rather than with silence. A schema
 * this tree does not create -- `storage` is the one the hosted platform would
 * add -- is reported as absent rather than as denied, because a denial nobody
 * could have granted is not evidence of anything.
 */
export async function storageSchemas(read: Read): Promise<readonly string[]> {
  const rows = await read<{ readonly nspname: string }>(`${OWN_SCHEMAS} order by 1`);
  return rows.map((row) => row.nspname);
}
