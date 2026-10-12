// SPDX-License-Identifier: AGPL-3.0-only
//
// A changed migration or harness file names a new template, and a long-lived
// server (a builder's local database, a lane's) kept every older one for good
// (#803). A build now drops other trees' templates past the newest three, and
// never the current tree's.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from './fresh-database.ts';
import { besideUrl, ensureMigratedTemplate, templateName } from './migrated-template.ts';

const configured = databaseUrlFromEnvironment();
const treeName = () => `migrated_${randomBytes(8).toString('hex')}`;

it.skipIf(configured === undefined)(
  "a build drops other trees' templates past the newest three and keeps the current tree's",
  async () => {
    const url = new URL(configured ?? '');
    url.pathname = '/conformance';
    const server = connectAsAdmin(besideUrl(url.toString()));
    url.pathname = '/postgres';
    const older = [treeName(), treeName(), treeName(), treeName(), treeName()];
    const built = treeName();
    const left = async (names: readonly string[]) =>
      (
        await server.execute<{ datname: string }>(
          'select datname from pg_database where datname = any($1::text[]) order by oid',
          [names],
        )
      ).map(({ datname }) => datname);
    const finished = async (name: string) => {
      await server.execute(`create database "${name}"`);
      await server.execute(`comment on database "${name}" is '{"migration":{}}'`);
      await server.execute(`alter database "${name}" allow_connections false`);
    };
    try {
      // The current tree's template exists before any older tree's is made.
      await ensureMigratedTemplate(url.toString());
      // Older trees' finished templates, oldest first, as a build leaves them.
      for (const name of older) {
        // oxlint-disable-next-line no-await-in-loop -- oldest first: a build drops by age
        await finished(name);
      }
      await ensureMigratedTemplate(url.toString(), built);
      expect(await left([...older, built, templateName()])).toStrictEqual([
        templateName(),
        ...older.slice(2),
        built,
      ]);
    } finally {
      await Promise.all(
        [...older, built].map((name) =>
          server.execute(`drop database if exists "${name}" with (force)`),
        ),
      );
      await server.close();
    }
  },
  240_000,
);
