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
// `--production` after any mode reaches production's store on production's
// network instead, and names its drill container as production's own; the
// drill still takes no target (deploy/production/README.md).
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
// receipt in the store (`backups.drills`) and one line in the operator's
// record folder, with the fields `RECEIPT_FIELDS` (drill-receipt.mjs) names
// and no other. A pass the store took also stamps its date on the
// installation's database (`ops.last_tested_restore`, migration 0070), where
// the operations view reads it (C55); a failed drill stamps nothing.
//
// The clean-host leg (S0-3e, recovery contract D-3) runs off the machine,
// where the store has no route: `--export` writes the newest sealed backup
// and its facts beside it (carried-archive.mjs), never the key; `--drill
// --archive <file>` restores that file anywhere, checked against its facts
// before anything opens it, and its receipt says it ran on a carried archive,
// is kept and printed, not stored, and carries no digest; it names the
// store's own id for the archive. `--record <file> --archive <file>` takes
// that receipt back into the store on the machine, only with that very
// archive, its digest computed again from the file, as bound parameters.
//
// Every mode is the installation's appointed operator's act only
// (REV158K criterion 4): `operations:manage` over the whole of the
// installation's operating business, the one row written at installation
// (migration 0045), which no value the caller sets replaces. The archive is
// the whole database, so another business's manager is refused before
// anything is read, and learns nothing. A passed drill is that operator's own
// attestation: the store takes a pass only through the store login the
// installation appointed as them (deploy/staging/backup-store.sql). An export
// and a drill from the store ask the gate again before each step with the
// store; each part comes sealed under a key the store releases only once the
// gate has answered again (backup-store-upgrade-3.sql), and the gate is asked
// once more after it, so an operator whose sign-in ended or whose
// `operations:manage` was revoked part way reads no further and keeps
// nothing.
//
// It prints one JSON line, passed or failed, and exits 0 or 1. A failed line
// names the stage and nothing else: Docker's, pg_restore's and the server's
// messages can carry record data, so they are never kept.

import { readFileSync, realpathSync } from 'node:fs';
import { reachFor, routeOf, stagingReach } from './backup-store-reach.mjs';
import {
  drillAsOperator as actAsOperator,
  exportArchive as exportAct,
  recordCarried,
} from './drill-acts.mjs';
import { restoreDrill } from './drill-restore.mjs';
import { requireOperatingOperator } from './operator.ts';

export { RECEIPT_FIELDS, recordDrill } from './drill-receipt.mjs';
export { fetchLatest, recordCarried } from './drill-acts.mjs';
export { docker } from './drill-docker.mjs';
export { restoreDrill } from './drill-restore.mjs';

/**
 * The drill as the operator the gate admitted runs it (drill-acts.mjs): the
 * drill, then its receipt; this drill unless a test passes its own. Its every
 * read of and write to the store asks the gate again first.
 */
export const drillAsOperator = ({ reach = stagingReach, prefix, ...options }) =>
  actAsOperator({
    drill: (drill) => restoreDrill({ ...drill, prefix }),
    ...options,
    reach: askingAgain(reach, options.gate),
  });

/**
 * `reach` asking the gate again (operator.ts, `stillOperator`) before each
 * call. The fetch reads each part in two calls, each begun only once the one
 * before it has ended (drill-acts.mjs, `fetchLatest`): the part, which the
 * store hands out sealed under a key of its own, then its release, the one
 * call handed `onLine`, which has the store hand out that key and log the
 * part's read. The store cannot see a sign-in, so a sign-in ended or a grant
 * revoked before the release is asked for leaves the operator with nothing
 * they can open, and the fetch removes what it wrote. The release asks once
 * more as the store's route takes its script, with the operator's grant held
 * from the call until the key's line, so a revocation cannot land between
 * that ask and the key; a key is one line, and the part's read is never under
 * the hold, so a revocation never waits on a read. The gate is asked again
 * once the key has arrived, so an ending during the release refuses that
 * part too, and nothing read is kept or reported. Every gate operator.ts
 * admits carries both.
 */
function askingAgain(reach, gate) {
  return async (url, script, onLine) => {
    await gate.stillOperator?.();
    if (onLine === undefined) return await reach(url, script, onLine);
    const hold = gate.holdingGrant ?? ((during) => during(() => {}));
    const answer = await hold(async (release) => {
      async function* asked() {
        await gate.stillOperator?.();
        yield* typeof script === 'string' ? [script] : script;
      }
      return await reach(url, asked(), (line) => {
        release();
        return onLine(line);
      });
    });
    await gate.stillOperator?.();
    return answer;
  };
}

/** `--export` (drill-acts.mjs), its every read of the store asking the gate again. */
export const exportArchive = ({ reach = stagingReach, ...options }) =>
  exportAct({ ...options, reach: askingAgain(reach, options.gate) });

const USAGE =
  'usage: restore-drill.mjs --drill [--archive <file>] | --export <file> | --record <receipt file> --archive <file>, then --production for production';

/** The one mode the command line names, and the unit it acts on (`--production` last), or the usage. */
export function modeOf(given) {
  const environment = given.at(-1) === '--production' ? 'production' : 'staging';
  return { ...oneMode(environment === 'production' ? given.slice(0, -1) : given), environment };
}

function oneMode(args) {
  const [flag, ...rest] = args;
  const file = rest.at(-1) ?? '';
  if (flag === '--drill' && rest.length === 0) return { mode: 'drill' };
  if (flag === '--drill' && rest.length === 2 && rest[0] === '--archive' && file !== '') {
    return { mode: 'drill', archiveFile: file };
  }
  if (flag === '--export' && rest.length === 1 && file !== '') return { mode: 'export', file };
  if (
    flag === '--record' &&
    rest.length === 3 &&
    rest[0] !== '' &&
    rest[1] === '--archive' &&
    file !== ''
  ) {
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
async function drillFromHere(gate, archiveFile, environment, reach, prefix) {
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
  return await drillAsOperator({ gate, storeUrl, archiveFile, privateKey, scope, reach, prefix });
}

/**
 * One run of the command line `args` in `environment`: the installation's
 * operator gate first (operator.ts, requireOperatingOperator), then the one
 * mode. Answers `{ refused }` with the gate's reason, or `{ mode, receipt }`.
 * `reach` is the store route, the unit's own unless a test passes its own.
 */
export async function runDrillCommand(args, { environment = process.env, reach } = {}) {
  const run = modeOf(args);
  const gate = await requireOperatingOperator(environment);
  if (!gate.ok) return { refused: gate.reason };
  const route = { reach: reach ?? reachFor(run.environment) };
  const { prefix } = routeOf(run.environment);
  let receipt;
  if (run.mode === 'export') {
    const storeUrl = need(environment, 'RESTORE_STORE_URL');
    receipt = await exportArchive({ gate, storeUrl, file: run.file, ...route });
  } else if (run.mode === 'record') {
    const storeUrl = need(environment, 'RESTORE_STORE_URL');
    const [receiptFile, archiveFile] = [run.file, run.archiveFile];
    receipt = await recordCarried({ gate, storeUrl, receiptFile, archiveFile, ...route });
  } else {
    receipt = await drillFromHere(gate, run.archiveFile, environment, route.reach, prefix);
  }
  return { mode: run.mode, receipt };
}

// The entry point by real path, so a checkout under a space or reached through a link still runs.
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(import.meta.filename)) {
  try {
    const { refused, mode, receipt } = await runDrillCommand(process.argv.slice(2));
    if (refused !== undefined) {
      process.stderr.write(`restore-drill: REFUSED: ${refused}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (receipt.outcome === 'pending') {
      process.stderr.write(
        'restore-drill: restored from a carried archive; it is not a passed drill until you record it with --record on the machine, with the archive\n',
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
