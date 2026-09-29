// SPDX-License-Identifier: AGPL-3.0-only
//
// T4e: the journey command proves itself (split section 3.2, row T4e; C225).
// Spawned by `pnpm verify:journey --self-test` (scripts may not import tests,
// so the command runs this as its own process, as it runs the journey), it
// prints one `journey-case {json}` line per check and exits 1 when any fails.
//
// On one scratch branch in a disposable worktree, installed once from the
// store, it first runs every check unmutated, which must be green, then:
//   T4-N1  deletes the newest migration: `migrations:unchanged` names it;
//   T4-N2  declares an operation no handler serves: the isolation matrix fails;
//   T4-N3  a registry entry with no screen, a duplicate route id and a changed
//          pinned-mockup byte each fail their own check, told apart by name;
//   T4-N4  reverts each part before T4e and reruns its invariant: it goes red.
// Last, `every_invariant_bites` lists every check that did not.
//
// Every database the checks create is on the command's own Postgres
// container, never the shared cluster: the run refuses a DATABASE_URL that is
// not that container's published port. T3d2's proofs start their own
// container on the ports the command hands over and remove it. The worktree
// and its branch are removed at the end, whatever happened.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  PARTS,
  changePinnedMockup,
  classify,
  control,
  deleteOneMigration,
  edit,
  everyInvariantBites,
  onOwnCluster,
  openScratch,
  revertPart,
  type CaseLine,
  type Part,
  type Ran,
  type Scratch,
} from './mutations.ts';
import { summarise, vitest, vitestReport } from './vitest-report.ts';

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`self-test: ${name} is not set`);
  return value;
};
const DATABASE_URL = env('DATABASE_URL');
const CLUSTER = env('SELF_TEST_CLUSTER');
const PROOFS_PORT = env('SELF_TEST_PROOFS_PORT');
const PROOFS_API_PORT = env('SELF_TEST_PROOFS_API_PORT');
const DOCKER = process.env['DOCKER'] ?? '/usr/local/bin/docker';
const ONLY = (process.env['SELF_TEST_ONLY'] ?? '').split(',').filter(Boolean);
const DB = { DATABASE_URL, DATABASE_ADMIN_URL: env('DATABASE_ADMIN_URL') };
const ISOLATION = 'tests/acceptance/role-case-matrix.test.ts';
const ROUTES = 'tests/surfaces/routes.test.ts';
const SCREENLESS = /has a screen for every authenticated route/u;
const PROOFS_FILE = 'tests/acceptance/runtime-proofs.test.tsx';

const lines: CaseLine[] = [];
function report(line: CaseLine): void {
  lines.push(line);
  console.log(`journey-case ${JSON.stringify(line)}`);
}

/** The run's own container, or nothing: the port DATABASE_URL names must be the one it publishes. */
function refuseAnotherCluster(): void {
  const published = spawnSync(DOCKER, ['port', CLUSTER, '5432/tcp'], { encoding: 'utf8' });
  // Both: the suites connect with the admin URL first (tests/support/fresh-database.ts).
  for (const [name, url] of Object.entries(DB)) {
    if (published.status !== 0 || !onOwnCluster(url, published.stdout)) {
      throw new Error(`self-test: ${name} is not ${CLUSTER}'s published port; refused`);
    }
  }
}

/** T3d2's process proofs on a container of their own, removed after. */
function proofs(scratch: Scratch): Ran {
  const name = `${CLUSTER}-self-test-proofs`;
  const evidence = join(scratch.dir, '.local', 'runtime-proofs.txt');
  rmSync(evidence, { force: true });
  const script = join(scratch.dir, 'scripts/local/runtime-proofs.sh');
  const args = [script, '--name', name, '--port', PROOFS_PORT, '--api-port', PROOFS_API_PORT];
  const run = spawnSync('bash', [...args, '--evidence', evidence], {
    cwd: scratch.dir,
    encoding: 'utf8',
    timeout: 1_200_000,
  });
  spawnSync(DOCKER, ['rm', '-f', '-v', name], { encoding: 'utf8' });
  // The script tees its output into the evidence: read one of the two, and
  // only T3d2's own file, since the script runs T3e1's drop proofs too.
  const said = (existsSync(evidence) ? readFileSync(evidence, 'utf8') : run.stdout).split('\n');
  const mark = (glyph: string): string[] =>
    said
      .filter((line) => line.includes(`${glyph} ${PROOFS_FILE} >`))
      .map((line) => line.slice(line.indexOf(`${PROOFS_FILE} >`) + PROOFS_FILE.length + 3).trim());
  const passed = mark('✓').length;
  const failed = mark('×').length;
  const cases = [
    ...mark('✓').map((title) => ({ name: title, passed: true })),
    ...mark('×').map((title) => ({ name: title, passed: false })),
  ];
  const whole = said.some((line) => /^\s*FAIL\s/u.test(line) && line.includes(`${PROOFS_FILE} [`));
  return {
    cases,
    applied: true,
    executed: passed + failed + (whole ? 1 : 0),
    red: failed > 0 || whole,
    detail:
      `runtime-proofs exit ${String(run.status)}; ${String(failed)} of ${String(passed + failed)} ` +
      `cases failed${whole ? `; ${PROOFS_FILE} fails whole` : ''}`,
  };
}

/**
 * The web typecheck. Unmutated, any error is red; mutated with a duplicate
 * route id, red means TS1117 in the route registry and nothing less.
 */
function typecheck(scratch: Scratch, duplicateOnly: boolean): Ran {
  const tsc = spawnSync(
    join(scratch.dir, 'node_modules/.bin/tsc'),
    ['-p', 'tsconfig.web.json', '--noEmit'],
    { cwd: scratch.dir, encoding: 'utf8', timeout: 600_000 },
  );
  const duplicate = /apps\/web\/src\/routes\.ts.*TS1117/u.test(tsc.stdout);
  return {
    applied: true,
    executed: 1,
    red: tsc.status !== 0 && (duplicate || !duplicateOnly),
    detail: `tsc exit ${String(tsc.status)}${duplicate ? ', TS1117 in apps/web/src/routes.ts' : ''}`,
  };
}

const ROUTE = (id: string): string =>
  `  '${id}': {\n    namespace: 'agency',\n    path: '/self-test',\n    title: 'Self test',\n` +
  `    surface: 'none',\n    rail: false,\n    authenticated: true,\n  },\n`;
const RECEIPT = "  read('task.receipt', TASK_COLLECTION, { authorisedOn: 'record' }),\n";

/** One mutation: set the scratch tree back, apply it, and run its check. */
function mutate(scratch: Scratch, name: string, apply: () => boolean, check: () => Ran): void {
  scratch.reset();
  const applied = apply();
  const ran = applied ? check() : { applied, executed: 0, red: false, detail: 'not applied' };
  report(classify(name, ran));
}

function negatives(scratch: Scratch): void {
  report(
    classify('T4-N1 a deleted migration fails the migration check', deleteOneMigration(scratch)),
  );
  mutate(
    scratch,
    'T4-N2 an operation with no isolation case fails the isolation matrix',
    () =>
      edit(
        scratch,
        'packages/core-wire/src/surface.ts',
        RECEIPT,
        `${RECEIPT}${RECEIPT.replace('task.receipt', 'task.self_test')}`,
      ),
    () => vitest(scratch, [ISOLATION], DB),
  );
  const routes = 'apps/web/src/routes.ts';
  const head = 'export const ROUTES = {\n';
  mutate(
    scratch,
    'T4-N3 a registry entry with no screen fails the route registry check',
    () => edit(scratch, routes, head, `${head}${ROUTE('agency:self-test')}`),
    () => vitest(scratch, [ROUTES], DB, SCREENLESS),
  );
  mutate(
    scratch,
    'T4-N3 a duplicate route id fails the typecheck',
    () => edit(scratch, routes, head, `${head}${ROUTE('agency:settings')}`),
    () => typecheck(scratch, true),
  );
  report(
    classify(
      'T4-N3 a changed pinned-mockup byte fails the mockup pin',
      changePinnedMockup(scratch),
    ),
  );
}

/** One revert of the part and its invariant rerun; see `revertPart` for `keepAdded`. */
function revertAndRun(scratch: Scratch, part: Part, name: string, keepAdded: boolean): CaseLine {
  const reverted = revertPart(scratch, part, keepAdded);
  if (!reverted.applied) {
    return classify(name, { applied: false, executed: 0, red: false, detail: reverted.detail });
  }
  const ran = part.id === 'T3d2' ? proofs(scratch) : vitest(scratch, part.files, DB);
  return classify(name, { ...ran, detail: `${reverted.detail}; ${ran.detail}` });
}

function reverts(scratch: Scratch, parts: readonly Part[]): void {
  for (const part of parts) {
    const name = `T4-N4 ${part.id} reverted: ${part.invariants.join(', ')}`;
    const whole = revertAndRun(scratch, part, name, false);
    // A file that no longer loads never runs the invariant; unwire the part instead.
    const unloadable = whole.status === 'fail' && whole.detail.includes('fails whole');
    report(unloadable ? revertAndRun(scratch, part, name, true) : whole);
  }
}

function controls(scratch: Scratch, parts: readonly Part[]): void {
  scratch.reset();
  const files = [
    ...new Set([
      ISOLATION,
      ROUTES,
      ...parts.filter((p) => p.id !== 'T3d2').flatMap((p) => p.files),
    ]),
  ];
  const all = vitestReport(scratch, files, DB);
  report(control('control: the isolation matrix', summarise(scratch, all, [ISOLATION])));
  report(control('control: the route registry check', summarise(scratch, all, [ROUTES])));
  report(control('control: the typecheck', typecheck(scratch, false)));
  for (const part of parts) {
    const ran = part.id === 'T3d2' ? proofs(scratch) : summarise(scratch, all, part.files);
    report(control(`control: ${part.id} ${part.invariants.join(', ')}`, ran));
  }
}

refuseAnotherCluster();
const parts = ONLY.length === 0 ? PARTS : PARTS.filter((part) => ONLY.includes(part.id));
const scratch = openScratch();
try {
  const install = spawnSync('corepack', ['pnpm', 'install', '--offline', '--frozen-lockfile'], {
    cwd: scratch.dir,
    encoding: 'utf8',
  });
  if (install.status !== 0)
    throw new Error(`self-test: install failed: ${install.stderr.slice(-400)}`);
  controls(scratch, parts);
  negatives(scratch);
  reverts(scratch, parts);
  for (const part of PARTS.filter((one) => !parts.includes(one))) {
    report({
      case: `T4-N4 ${part.id}`,
      status: 'fail',
      detail: 'unrun: left out by SELF_TEST_ONLY',
    });
  }
} catch (error) {
  report({ case: 'the self-test run itself', status: 'fail', detail: String(error) });
} finally {
  scratch.close();
}
const whole = everyInvariantBites(lines);
report(whole);
process.exitCode = whole.status === 'pass' ? 0 : 1;
