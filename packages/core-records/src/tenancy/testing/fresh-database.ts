// SPDX-License-Identifier: AGPL-3.0-only
//
// The harness: one fresh database per run, migrated from empty.
//
// The point of migrating from empty every time is that a schema which only
// works because of what happened to be there already is a schema nobody can
// install. It also means the conformance set reads a catalogue produced by
// the migrations alone.
//
// Two roles, deliberately. Migrations run as the owner, because they create
// things. The application connects as a member of `ops_astro_app`, which owns
// nothing and has no create privilege anywhere, so `FORCE ROW LEVEL SECURITY`
// is not the only thing standing between one tenant and another and runtime
// DDL is refused by the server rather than by good manners.

import { randomBytes, randomUUID } from 'node:crypto';
import { connect, connectAsAdmin, type AdminConnection, type Database } from '../database.ts';
import { createStatementLog, type StatementLog } from '../statements.ts';
import { migrate, type MigrationOutcome } from '../migrate.ts';

/** The group role the migrations grant to. Members are per-installation logins. */
export const APPLICATION_ROLE = 'ops_astro_app';

export interface EmptyDatabase {
  readonly name: string;
  /** One trail across both connections, labelled by source. */
  readonly log: StatementLog;
  /** The owner connection. Migrations and catalogue reads. */
  readonly admin: AdminConnection;
  /** The application connection, as a role that owns nothing. */
  readonly app: Database;
  /** The same credentials as a raw handle, so a test can watch the session itself. */
  readonly appUrl: string;
  readonly loginRole: string;
  /**
   * A login that is a member of nothing and was granted nothing. The third
   * separated role: the owner builds, the application role is granted what it
   * needs, and this one stands for every other role on the cluster. It may
   * connect, so a refusal is a refusal the server gave rather than one a test
   * decided not to ask for.
   */
  readonly restrictedRole: string;
  readonly restrictedUrl: string;
  drop(): Promise<void>;
}

export interface FreshDatabase extends EmptyDatabase {
  readonly migration: MigrationOutcome;
}

export interface FreshDatabaseOptions {
  /** Defaults to `DATABASE_ADMIN_URL`, then `DATABASE_URL`. Its server hosts the new database. */
  readonly serverUrl?: string;
  /** The part this run belongs to, so a database name says who left it behind. */
  readonly part?: string;
  readonly migrationsDirectory?: string;
}

function identifier(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

function urlFor(serverUrl: string, database: string, user?: string, password?: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  if (user !== undefined) url.username = encodeURIComponent(user);
  if (password !== undefined) url.password = encodeURIComponent(password);
  return url.toString();
}

/**
 * The server this harness creates its throwaway databases on.
 *
 * `DATABASE_ADMIN_URL` first, because creating a database and a login role is
 * the owner's work and the local contract gives `DATABASE_URL` to the runtime
 * role `app`, which owns nothing and may not create. `DATABASE_URL` remains the
 * fallback for the draft's own arrangement, where one URL was both.
 */
export function databaseUrlFromEnvironment(): string | undefined {
  const url = process.env['DATABASE_ADMIN_URL'] ?? process.env['DATABASE_URL'];
  return url === undefined || url === '' ? undefined : url;
}

/**
 * A database and its three roles, with no schema in it at all.
 *
 * The prefix harness starts here and applies migrations one at a time, so
 * what it asserts after `000k` is the state an installation stopped between
 * two migrations is really in.
 */
export async function createEmptyDatabase(
  options: FreshDatabaseOptions = {},
): Promise<EmptyDatabase> {
  const serverUrl = options.serverUrl ?? databaseUrlFromEnvironment();
  if (serverUrl === undefined) {
    throw new Error('createEmptyDatabase: no DATABASE_URL and no serverUrl given');
  }
  const part = options.part ?? 'a';
  const name = `t1_${part}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const loginRole = `${name}_app`;
  const restrictedRole = `${name}_out`;
  const password = randomBytes(24).toString('base64url');
  const restrictedPassword = randomBytes(24).toString('base64url');
  const log = createStatementLog();

  const server = connectAsAdmin(serverUrl, { source: 'harness', log });
  try {
    // The group role is cluster-wide and shared; the login roles are this
    // run's alone, so two runs on one server never share a credential.
    await server.execute(
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = '${APPLICATION_ROLE}') then
           create role ${APPLICATION_ROLE} nologin;
         end if;
       end $$`,
    );
    await server.execute(`create database ${identifier(name)}`);
    // PostgreSQL grants TEMPORARY on a new database to PUBLIC. A temporary
    // table is created in `pg_temp`, outside every schema the application is
    // refused CREATE in, and on a pooled backend it outlives the transaction
    // and shadows `records` for the next tenant. Revoked where the database is
    // made, so the application may create nothing at all (R2-AUTHORITY-61).
    await server.execute(`revoke temporary on database ${identifier(name)} from public`);
    // Neither password can be a bound parameter in CREATE ROLE. Both are 24
    // random bytes in base64url, whose alphabet holds no quote, so there is
    // nothing here to escape and nothing a caller could have supplied.
    await server.execute(
      `create role ${identifier(loginRole)} login password '${password}' ` +
        `nosuperuser nocreatedb nocreaterole nobypassrls inherit in role ${APPLICATION_ROLE}`,
    );
    await server.execute(
      `create role ${identifier(restrictedRole)} login password '${restrictedPassword}' ` +
        `nosuperuser nocreatedb nocreaterole nobypassrls inherit`,
    );
    await server.execute(
      `grant connect on database ${identifier(name)} to ${identifier(restrictedRole)}`,
    );
  } finally {
    await server.close();
  }

  const admin = connectAsAdmin(urlFor(serverUrl, name), { source: 'migration', log });
  const appUrl = urlFor(serverUrl, name, loginRole, password);
  const app = connect(appUrl, { source: 'runtime', log });

  return {
    name,
    log,
    admin,
    app,
    appUrl,
    loginRole,
    restrictedRole,
    restrictedUrl: urlFor(serverUrl, name, restrictedRole, restrictedPassword),
    async drop(): Promise<void> {
      await app.close();
      await admin.close();
      const cleanup = connectAsAdmin(serverUrl, { source: 'harness', log });
      try {
        await cleanup.execute(`drop database if exists ${identifier(name)} with (force)`);
        await cleanup.execute(`drop role if exists ${identifier(loginRole)}`);
        await cleanup.execute(`drop role if exists ${identifier(restrictedRole)}`);
      } finally {
        await cleanup.close();
      }
    },
  };
}

export async function createFreshDatabase(
  options: FreshDatabaseOptions = {},
): Promise<FreshDatabase> {
  const empty = await createEmptyDatabase(options);
  const migration = await migrate(empty.admin, options.migrationsDirectory ?? 'migrations');
  return { ...empty, migration };
}
