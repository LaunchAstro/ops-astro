// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill itself (restore-drill.mjs, S0-3c to S0-3e): the archive
// fetched into a folder of its own, its seal checked, the whole backup
// restored into a throwaway container of the production major with no
// network, and the copy checked as the tenancy role under the named business.
// restore-drill.mjs runs it behind the operator gate and re-exports it.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EFFECTIVE_GRANTS } from '../../packages/core-records/src/index.ts';
import { checkSealedFile, openSealedFile } from './archive-seal.mjs';
import { docker, must } from './drill-docker.mjs';

const APP_ROLE = 'ops_astro_app';
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const DB = 'drill';
const AS = ['-U', 'postgres', '-d', DB];
// Its own path, not the image's volume, so every major takes it.
const PGDATA = '/var/lib/postgresql/drill';

const staging = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
);
const PRODUCTION_MAJOR = staging['x-ops-astro'].productionDatabaseMajor;

/**
 * Restores the archive `fetchArchive(file)` writes into `file` (or answers as
 * `body`) into a container of `image` and checks it. Returns the drill's record; never throws. `image` defaults to
 * staging's pinned Postgres, the major production gets.
 */
export async function restoreDrill({
  fetchArchive,
  privateKey,
  scope,
  docker: run = docker,
  image = staging.services.db.image,
}) {
  const record = {
    event: 'restore drill',
    outcome: 'failed',
    at: new Date().toISOString(),
    target: 'throwaway container',
    productionMajor: PRODUCTION_MAJOR,
    sourceMajor: null,
    targetMajor: null,
    timings: {},
  };
  const name = `${staging['x-ops-astro'].ownPrefix}-drill-${randomBytes(4).toString('hex')}`;
  const exec = (args, input) => run(['exec', ...(input ? ['-i'] : []), name, ...args], input);
  const psql = async (...commands) =>
    (await must(exec(['psql', ...AS, '-Atq', ...commands.flatMap((c) => ['-c', c])]))).trim();
  let stage = 'scope';
  const timed = async (step, work) => {
    stage = step;
    const start = performance.now();
    try {
      return await work();
    } finally {
      record.timings[step] = Math.round(performance.now() - start);
    }
  };
  let started = false;
  const folder = mkdtempSync(join(tmpdir(), 'ops-astro-drill-'));
  const sealed = join(folder, 'archive.sealed');
  try {
    if (![scope?.business, scope?.client, scope?.person].every((id) => ID.test(id ?? ''))) {
      throw new Error('scope is not three ids');
    }
    const archive = await timed('fetch', async () => {
      const fetched = await fetchArchive(sealed);
      if (fetched.body !== undefined)
        writeFileSync(sealed, fetched.body, { mode: 0o600, flag: 'wx' });
      return fetched;
    });
    record.archiveTakenAt = archive.takenAt;
    // The tag over the whole file first, keeping no plaintext; only then does
    // any plaintext go anywhere, and only into the container's pg_restore.
    await timed('open', () => checkSealedFile(sealed, privateKey));
    const dump = () => openSealedFile(sealed, privateKey);
    await timed('start', async () => {
      started = true;
      // No network and no published port: nothing outside can reach it, and it
      // can reach nothing. Local trust is safe for the same reason. The data
      // directory is memory only, so restored rows never reach the disk.
      const container = `-d --rm --network none --name ${name} --tmpfs ${PGDATA} -e PGDATA=${PGDATA}`;
      const env = `-e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=${DB}`;
      await must(run(['run', ...`${container} ${env}`.split(' '), image]));
      let ready = false;
      for (let i = 0; i < 120 && !ready; i += 1) {
        // Over TCP, not the socket: the image's init server listens on the socket only.
        // oxlint-disable-next-line no-await-in-loop
        const probe = await exec(['pg_isready', '-h', '127.0.0.1', ...AS]);
        ready = probe.code === 0;
        if (!ready) {
          // oxlint-disable-next-line no-await-in-loop
          await new Promise((resolve) => {
            setTimeout(resolve, 500);
          });
        }
      }
      record.targetMajor = Math.floor(Number(await psql('show server_version_num')) / 10_000);
      stage = 'target';
      if (record.targetMajor !== PRODUCTION_MAJOR) throw new Error('not the production major');
    });
    const expected = await timed('restore', async () => {
      const listed = await must(exec(['pg_restore', '--list'], dump()));
      record.sourceMajor = Number(/Dumped from database version: (\d+)/u.exec(listed)?.[1]);
      // The archive makes its own public schema; the empty one would collide.
      await psql('drop schema public');
      const flags = ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges'];
      await must(exec(['pg_restore', ...flags, ...AS], dump()));
      return [...listed.matchAll(/^\d+; \d+ \d+ TABLE DATA (\S+) (\S+) /gmu)].map(
        ([, schema, table]) => `${schema}.${table}`,
      );
    });
    await timed('check', async () => {
      // The owner session grants the tenancy role its reads and reads nothing
      // itself. Every read runs as that role under the named business, where
      // the forced business barrier shows exactly one business: more means the
      // barrier did not survive the restore, and a person or client of another
      // business is not there to find. Within it, the named person must be a
      // current member holding a live grant to read the named client, as the
      // product's own read asks it (collection `person`, action `read`, at party
      // or business scope), or the business's people manager (Sol's reviews of
      // #120). Live is the product's definition, parent chain included.
      await psql(
        `create role ${APP_ROLE} nologin`,
        `grant usage on schema public to ${APP_ROLE}`,
        `grant select on all tables in schema public to ${APP_ROLE}`,
        `grant execute on function public.app_business_id() to ${APP_ROLE}`,
      );
      const [p, c] = [scope.person, scope.client];
      const [tables = '', granted, businesses, people] = (
        await psql(
          `set role ${APP_ROLE}`,
          `set app.business_id = '${scope.business}'`,
          `${EFFECTIVE_GRANTS} select (select string_agg(schemaname || '.' || tablename, ',') from pg_tables
             where schemaname in ('public', 'ops')),
             (exists (select from public.memberships where person_id = '${p}' and active)
             and exists (select from effective where subject_kind = 'person' and subject_id = '${p}'
               and collection = 'person' and (action = 'read' and (scope_kind = 'business'
               or scope_kind = 'party' and scope_id = '${c}') or action = 'manage' and scope_kind = 'business'))
             )::int, (select count(*) from public.businesses),
             (select count(*) from public.people where id in ('${p}', '${c}'))`,
        )
      ).split('|');
      const present = new Set(tables.split(','));
      const whole = expected.length > 0 && expected.every((t) => present.has(t));
      if (!whole || granted !== '1' || businesses !== '1' || people !== '2')
        throw new Error('check failed');
      record.tables = expected.length;
      record.readAs = APP_ROLE;
    });
    record.outcome = 'passed';
  } catch {
    record.stage = stage;
  } finally {
    // With its volumes: an image's declared volume outlives `rm -f` alone.
    if (started) await run(['rm', '-f', '-v', name]);
    rmSync(folder, { recursive: true, force: true });
  }
  return record;
}
