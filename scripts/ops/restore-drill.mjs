// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill, `ops restore --drill` (ticket S0-3, lines C2, C3 and C8;
// LF-3). The operator runs it on the machine, from the runbook:
//
//   node --env-file=<drill env> scripts/ops/restore-drill.mjs --drill
//   node --env-file=<drill env> scripts/ops/restore-drill.mjs --export <file>
//   node --env-file=<drill env> scripts/ops/restore-drill.mjs --drill --archive <file>
//   node --env-file=<drill env> scripts/ops/restore-drill.mjs --record <receipt file> --archive <file>
//     RESTORE_STORE_URL  a login holding ops_astro_backup_restore on the store,
//                        its host as staging's network names the store (backups)
//     RESTORE_KEY_FILE   the operator's private key, held apart from the store
//     DRILL_BUSINESS_ID, DRILL_CLIENT_ID, DRILL_PERSON_ID  the one scope it reads
//
// It takes the newest backup from the store (the store logs the read), through
// psql on staging's network (backup-store-reach.mjs), since the store publishes
// no port, part by part into a sealed file of its own (a folder of its own,
// mode 600, removed when it ends), so no archive is held whole in memory
// (REV158S criterion 5); checks the seal over the whole file, then starts a throwaway container of the production
// major with no network, restores the whole backup into it, checks the result and removes
// the container. It takes no target: the one database it writes is the one it
// started, so it cannot reach the managed project or any other server. It
// reads the restored copy only as the tenancy role, under the named business,
// where row security shows it that business alone, and checks the named
// person and client there.
//
// It stays out of apps/cli, which never opens a database (apps/cli/main.ts:7).
// It is a person's act under `operations:manage` (S0-3d): the operator gate
// (`operator.ts`, with OPS_ASTRO_TOKEN, OPS_ASTRO_BUSINESS and the rest the
// runbook sets) answers before the key, the store or Docker is touched, and a
// refusal writes nothing. A drill that ran, passed or failed, leaves one
// receipt in the store (`backups.drills`, where the operations view reads the
// date of the last tested restore) and one line in the operator's record
// folder, with the fields `RECEIPT_FIELDS` (drill-receipt.mjs) names and no
// other.
//
// The clean-host leg (S0-3e, recovery contract D-3) runs off the machine,
// where the store has no route: `--export` writes the newest sealed backup
// and its facts beside it (carried-archive.mjs), never the key; `--drill
// --archive <file>` restores that file anywhere, checked against its facts
// before anything opens it, and its receipt says it ran on a carried archive,
// is kept and printed, not stored, and carries no digest; the restore
// challenge it read back from the restored database is kept beside the
// archive, never printed. `--record <file> --archive <file>` takes that
// receipt back into the store on the machine, with the archive's digest
// computed again from the file and the challenge, both as bound parameters.
//
// Every mode is the installation's appointed operator's act only
// (REV158K criterion 4): `operations:manage` over the whole of the operating
// business the installation's drill environment names
// (OPS_ASTRO_OPERATING_BUSINESS). The archive is the whole database, so
// another business's manager is refused before anything is read, and learns
// nothing.
//
// It prints one JSON line, passed or failed, and exits 0 or 1. A failed line
// names the stage and nothing else: Docker's, pg_restore's and the server's
// messages can carry record data, so they are never kept.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EFFECTIVE_GRANTS } from '../../packages/core-records/src/index.ts';
import { checkSealedFile, openSealedFile } from './archive-seal.mjs';
import { drillAsOperator as actAsOperator, exportArchive, recordCarried } from './drill-acts.mjs';
import { docker, must } from './drill-docker.mjs';
import { requireOperatingOperator } from './operator.ts';

export { RECEIPT_FIELDS, recordDrill } from './drill-receipt.mjs';
export { exportArchive, fetchLatest, recordCarried } from './drill-acts.mjs';
export { docker } from './drill-docker.mjs';

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
      // The restore challenge the job wrote before this dump (migration 0034),
      // read back as the tenancy role like every read here: evidence only a
      // restore gives. It is kept off the record's own fields, so no receipt,
      // line or log can carry it.
      const kept = await psql(`select to_regclass('ops.restore_challenge') is not null`);
      if (kept === 't') {
        await psql(
          `grant usage on schema ops to ${APP_ROLE}`,
          `grant select on ops.restore_challenge to ${APP_ROLE}`,
        );
        const challenge = await psql(
          `set role ${APP_ROLE}`,
          `set app.business_id = '${scope.business}'`,
          'select challenge from ops.restore_challenge',
        );
        Object.defineProperty(record, 'challenge', { value: challenge, enumerable: false });
      }
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

/**
 * The drill as the operator the gate admitted runs it (drill-acts.mjs): the
 * drill, then its receipt; this drill unless a test passes its own.
 */
export const drillAsOperator = (options) => actAsOperator({ drill: restoreDrill, ...options });

const USAGE =
  'usage: restore-drill.mjs --drill [--archive <file>] | --export <file> | --record <receipt file> --archive <file>';

/** The one mode the command line names, or the usage. */
function modeOf(args) {
  const [flag, ...rest] = args;
  const file = rest.at(-1) ?? '';
  if (flag === '--drill' && rest.length === 0) return { mode: 'drill' };
  if (flag === '--drill' && rest.length === 2 && rest[0] === '--archive' && file !== '') {
    return { mode: 'drill', archiveFile: file };
  }
  if (flag === '--export' && rest.length === 1 && file !== '') return { mode: 'export', file };
  if (flag === '--record' && rest.length === 3 && rest[0] !== '' && rest[1] === '--archive' && file !== '') {
    return { mode: 'record', file: rest[0], archiveFile: file };
  }
  throw new Error(USAGE);
}

function need(environment, name) {
  const value = environment[name];
  if (value === undefined || value === '') throw new Error(`${name} is unset`);
  return value;
}

/** `--drill`, from the store or from a carried archive: the drill's receipt. */
async function drillFromHere(gate, archiveFile, environment, reach) {
  const storeUrl = archiveFile === undefined ? need(environment, 'RESTORE_STORE_URL') : undefined;
  let privateKey;
  try {
    privateKey = readFileSync(need(environment, 'RESTORE_KEY_FILE'), 'utf8');
  } catch {
    throw new Error('RESTORE_KEY_FILE is unset or unreadable');
  }
  const scope = {
    business: environment.DRILL_BUSINESS_ID,
    client: environment.DRILL_CLIENT_ID,
    person: environment.DRILL_PERSON_ID,
  };
  return await drillAsOperator({ gate, storeUrl, archiveFile, privateKey, scope, reach });
}

/**
 * One run of the command line `args` in `environment`: the installation's
 * operator gate first (operator.ts, requireOperatingOperator), then the one
 * mode. Answers `{ refused }` with the gate's reason, or `{ mode, receipt }`.
 * `reach` is the store route, staging's unless a test passes its own.
 */
export async function runDrillCommand(args, { environment = process.env, reach } = {}) {
  const run = modeOf(args);
  const gate = await requireOperatingOperator(environment);
  if (!gate.ok) return { refused: gate.reason };
  const route = reach === undefined ? {} : { reach };
  let receipt;
  if (run.mode === 'export') {
    const storeUrl = need(environment, 'RESTORE_STORE_URL');
    receipt = await exportArchive({ gate, storeUrl, file: run.file, ...route });
  } else if (run.mode === 'record') {
    const storeUrl = need(environment, 'RESTORE_STORE_URL');
    const [receiptFile, archiveFile] = [run.file, run.archiveFile];
    receipt = await recordCarried({ gate, storeUrl, receiptFile, archiveFile, ...route });
  } else {
    receipt = await drillFromHere(gate, run.archiveFile, environment, reach);
  }
  return { mode: run.mode, receipt };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { refused, mode, receipt } = await runDrillCommand(process.argv.slice(2));
    if (refused !== undefined) {
      process.stderr.write(`restore-drill: REFUSED: ${refused}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (receipt.outcome === 'pending') {
      process.stderr.write(
        'restore-drill: restored from a carried archive; it is not a passed drill until --record on the machine takes it with the archive and its restore challenge\n',
      );
    }
    // A drill exits 0 only on a pass, 3 while a carried restore is pending, else
    // 1; an export or a record that ran exits 0.
    const exits = { passed: 0, pending: 3 };
    process.exitCode = mode === 'drill' ? (exits[receipt.outcome] ?? 1) : 0;
  } catch (error) {
    // A system error's text names its file; the operator is told the step alone.
    const said = error?.code === undefined ? error.message : 'a file or system step failed';
    process.stderr.write(`restore-drill: ${said}\n`);
    process.exitCode = 2;
  }
}
