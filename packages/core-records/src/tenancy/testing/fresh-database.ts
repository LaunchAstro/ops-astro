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

export interface FreshDatabase {
  readonly name: string;
  /** One trail across both connections, labelled by source. */
  readonly log: StatementLog;
  readonly migration: MigrationOutcome;
  /** The owner connection. Migrations and catalogue reads. */
  readonly admin: AdminConnection;
  /** The application connection, as a role that owns nothing. */
  readonly app: Database;
  /** The same credentials as a raw handle, so a test can watch the session itself. */
  readonly appUrl: string;
  readonly loginRole: string;
  drop(): Promise<void>;
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

export async function createFreshDatabase(
  options: FreshDatabaseOptions = {},
): Promise<FreshDatabase> {
  const serverUrl = options.serverUrl ?? databaseUrlFromEnvironment();
  if (serverUrl === undefined) {
    throw new Error('createFreshDatabase: no DATABASE_URL and no serverUrl given');
  }
  const part = options.part ?? 'a';
  const name = `t1_${part}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const loginRole = `${name}_app`;
  const password = randomBytes(24).toString('base64url');
  const log = createStatementLog();

  const server = connectAsAdmin(serverUrl, { source: 'harness', log });
  try {
    // The group role is cluster-wide and shared; the login role is this run's
    // alone, so two runs on one server never share a credential.
    await server.execute(
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = '${APPLICATION_ROLE}') then
           create role ${APPLICATION_ROLE} nologin;
         end if;
       end $$`,
    );
    await server.execute(`create database ${identifier(name)}`);
    await server.execute(
      // The password cannot be a bound parameter in CREATE ROLE. It is 24
      // random bytes in base64url, whose alphabet holds no quote, so there is
      // nothing here to escape and nothing a caller could have supplied.
      `create role ${identifier(loginRole)} login password '${password}' ` +
        `nosuperuser nocreatedb nocreaterole nobypassrls inherit in role ${APPLICATION_ROLE}`,
    );
  } finally {
    await server.close();
  }

  const admin = connectAsAdmin(urlFor(serverUrl, name), { source: 'migration', log });
  const migrationsDirectory = options.migrationsDirectory ?? 'migrations';
  const migration = await migrate(admin, migrationsDirectory);

  const appUrl = urlFor(serverUrl, name, loginRole, password);
  const app = connect(appUrl, { source: 'runtime', log });

  return {
    name,
    log,
    migration,
    admin,
    app,
    appUrl,
    loginRole,
    async drop(): Promise<void> {
      await app.close();
      await admin.close();
      const cleanup = connectAsAdmin(serverUrl, { source: 'harness', log });
      try {
        await cleanup.execute(`drop database if exists ${identifier(name)} with (force)`);
        await cleanup.execute(`drop role if exists ${identifier(loginRole)}`);
      } finally {
        await cleanup.close();
      }
    },
  };
}
