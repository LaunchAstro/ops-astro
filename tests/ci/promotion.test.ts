// SPDX-License-Identifier: AGPL-3.0-only
// S0-1d: the promotion step. Production gets the exact artefact staging ran,
// never a fresh build; the step asks the service manager whether the API and
// the auth server are stopped, refuses while either runs (idle or not), and
// only then migrates, points production at the artefact and starts them.
//
// The step's decisions are tested through `promote` with its effects watched;
// the command is run as the owner runs it, over a fixture artefact store and
// fixture service-manager output, the way S0-1a's report is tested.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  parseService,
  promote,
  type PromotionEffects,
  type PromotionRequest,
  type ServiceRef,
  type ServiceState,
} from '../../scripts/ops/promotion.ts';
import { outputDigest } from '../../scripts/ops/build-output.ts';

const COMMAND = new URL('../../scripts/ops/promote.mjs', import.meta.url).pathname;
const definition = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
) as { 'x-ops-astro': { artefact: string } };
/** The artefact name S0-1a's definition names, for one version. */
const named = (version: string): string =>
  definition['x-ops-astro'].artefact.replace('{version}', version);

const STAGED = '0123456789ab';
const NEWER = 'fedcba987654';
const LINE = 'Tried the task page and the approval queue on staging; both behave.';
const CANARY = 'canary-5d1e9a-promotion-secret';

const scratch = mkdtempSync(join(tmpdir(), 's0-1d-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let stores = 0;
/** An artefact store: one directory per build, each carrying its own stamp. */
const store = (builds: Record<string, string | null>): string => {
  stores += 1;
  const root = join(scratch, `store${stores}`);
  for (const [name, stamp] of Object.entries(builds)) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'index.html'), `<meta name="ops-astro-build">`);
    if (stamp === null) continue;
    writeFileSync(join(root, name, 'build.json'), JSON.stringify({ build: stamp }));
    const digest = outputDigest(join(root, name));
    writeFileSync(join(root, name, 'build.json'), JSON.stringify({ build: stamp, digest }));
  }
  return root;
};
const STORE = (): string => store({ [named(STAGED)]: STAGED, [named(NEWER)]: NEWER });

const API: ServiceRef = { manager: 'docker', name: 'prod-api' };
const AUTH: ServiceRef = { manager: 'launchd', name: 'org.example.prod-auth' };

/** Effects that record every call, over a fixed service-manager answer. */
const watched = (states: readonly ServiceState[], migrates = true) => {
  const calls: string[] = [];
  const effects: PromotionEffects = {
    services: () => {
      calls.push('services');
      return states;
    },
    migrate: () => {
      calls.push('migrate');
      return migrates;
    },
    point: (current, artefact) => calls.push(`point ${current} -> ${artefact}`),
    start: (service) => calls.push(`start ${service.manager}:${service.name}`),
  };
  return { calls, effects };
};
const state = (ref: ServiceRef, running: boolean): ServiceState => ({ ...ref, running });
const request = (over: Partial<PromotionRequest> = {}): PromotionRequest => ({
  version: STAGED,
  store: STORE(),
  line: LINE,
  dryRun: false,
  api: API,
  auth: AUTH,
  current: join(scratch, 'current'),
  ...over,
});

const run = (args: string[], env: Record<string, string> = {}) => {
  const result = spawnSync(process.execPath, [COMMAND, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};
const fixture = (name: string, text: string): string => {
  const path = join(scratch, name);
  writeFileSync(path, text);
  return path;
};
// ---- S0-1 promotion same artefact (the invariant) --------------------------

describe('S0-1 promotion same artefact', () => {
  promotionSameArtefactCases1();
  promotionSameArtefactCases2();
});

function promotionSameArtefactCases1() {
  it('the dry run picks the artefact the staging definition names and records its stamp', () => {
    const { calls, effects } = watched([]);
    const outcome = promote(request({ dryRun: true }), effects);
    expect(outcome.kind).toBe('dry-run');
    if (outcome.kind !== 'dry-run') return;
    expect(outcome.artefactPath.endsWith(`/${named(STAGED)}`)).toBe(true);
    expect(outcome.record).toEqual({
      action: 'promotion recorded',
      version: STAGED,
      artefact: named(STAGED),
      line: LINE,
      dryRun: true,
    });
    // A dry run asks nothing of the machine and changes nothing.
    expect(calls).toEqual([]);
  });

  it('never another build: a different stamp, no stamp, no artefact or a dirty build is refused', () => {
    const cases: [Partial<PromotionRequest>, RegExp][] = [
      [{ store: store({ [named(STAGED)]: NEWER }) }, /carries fedcba987654, not 0123456789ab/u],
      [{ store: store({ [named(STAGED)]: null }) }, /carries no stamp/u],
      [{ store: store({ [named(NEWER)]: NEWER }) }, /no artefact ops-astro-0123456789ab/u],
      [{ version: `${STAGED}-dirty` }, /not a clean build identifier/u],
      [{ version: '../escape' }, /not a clean build identifier/u],
    ];
    for (const [over, reason] of cases) {
      for (const dryRun of [true, false]) {
        const { calls, effects } = watched([state(API, false), state(AUTH, false)]);
        const outcome = promote(request({ ...over, dryRun }), effects);
        expect(outcome.kind).toBe('refused');
        if (outcome.kind === 'refused') expect(outcome.reason).toMatch(reason);
        expect(calls).toEqual([]);
      }
    }
  });

  it('the same bytes: an artefact changed after its digest, or recording none, is refused', () => {
    const changed = STORE();
    writeFileSync(join(changed, named(STAGED), 'index.html'), '<p>another build</p>');
    const bare = STORE();
    writeFileSync(join(bare, named(STAGED), 'build.json'), JSON.stringify({ build: STAGED }));
    const cases = [
      [changed, /does not hold the bytes its digest records/u],
      [bare, /records no digest/u],
    ] as const;
    for (const [root, reason] of cases) {
      for (const dryRun of [true, false]) {
        const { calls, effects } = watched([state(API, false), state(AUTH, false)]);
        const outcome = promote(request({ store: root, dryRun }), effects);
        expect(outcome).toMatchObject({ kind: 'refused', reason: expect.stringMatching(reason) });
        expect(calls).toEqual([]);
      }
    }
  });

  it("records the owner's one line, and refuses without exactly one", () => {
    for (const line of ['', '   ', 'tried it\nand it was fine', 'x'.repeat(201)]) {
      const { calls, effects } = watched([]);
      const outcome = promote(request({ line, dryRun: true }), effects);
      expect(outcome.kind).toBe('refused');
      if (outcome.kind === 'refused') expect(outcome.reason).toMatch(/one line/u);
      expect(calls).toEqual([]);
    }
  });
}

function promotionSameArtefactCases2() {
  it('the command dry-runs over a store and prints the record, and nothing else', () => {
    const artefacts = STORE();
    const result = run(
      ['--dry-run', '--version', STAGED, '--artefacts', artefacts, '--line', LINE],
      { DATABASE_ADMIN_URL: `postgres://owner:${CANARY}@db.example/prod` },
    );
    expect(result.status, result.out).toBe(0);
    const record = JSON.parse(result.out.split('\n').find((l) => l.startsWith('{')) ?? '{}');
    expect(record).toMatchObject({ version: STAGED, artefact: named(STAGED), line: LINE });
    expect(result.out).toMatch(/dry run/u);
    expect(result.out).not.toContain(CANARY);
    const refused = run([
      '--dry-run',
      '--version',
      NEWER,
      '--artefacts',
      store({}),
      '--line',
      LINE,
    ]);
    expect(refused.status, refused.out).toBe(1);
  });
}

// ---- S0-1 promotion refuses running app -----------------------------------

describe('S0-1 promotion refuses running app', () => {
  it('refuses while the API or the auth server runs, idle or not, says what to stop, and does nothing', () => {
    const cases: [ServiceState[], RegExp][] = [
      [[state(API, true), state(AUTH, false)], /docker:prod-api is running/u],
      [[state(API, false), state(AUTH, true)], /launchd:org\.example\.prod-auth is running/u],
      [[state(API, true), state(AUTH, true)], /prod-api is running.*prod-auth is running/su],
      [[state(AUTH, false)], /cannot find docker:prod-api/u],
    ];
    for (const [states, reason] of cases) {
      const { calls, effects } = watched(states);
      const outcome = promote(request(), effects);
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') continue;
      expect(outcome.reason).toMatch(reason);
      expect(outcome.reason).toMatch(/stop/iu);
      expect(calls).toEqual(['services']);
    }
  });

  // The command-level cases (the live service manager's refusal, no saved
  // report, no unknown argument) run past S0-1e's operator gate as a signed-in
  // operator, so they live in tests/ci/operator-only.test.ts.

  it('names services only as docker:<name> or launchd:<label>', () => {
    expect(parseService('docker:prod-api')).toEqual(API);
    expect(parseService('launchd:org.example.prod-auth')).toEqual(AUTH);
    for (const bad of [
      'prod-api',
      'systemd:x',
      'docker:',
      'docker:a b',
      'docker:-rm',
      'launchd:$(x)',
    ]) {
      expect(() => parseService(bad), bad).toThrow(/docker:<name> or launchd:<label>/u);
    }
  });
});

// ---- S0-1 promotion migrates stopped app ----------------------------------

describe('S0-1 promotion migrates stopped app', () => {
  it('with both stopped: migrates, points production at the staged artefact, starts auth then API', () => {
    const { calls, effects } = watched([state(API, false), state(AUTH, false)]);
    const req = request();
    const outcome = promote(req, effects);
    expect(outcome.kind).toBe('promoted');
    if (outcome.kind !== 'promoted') return;
    expect(calls).toEqual([
      'services',
      'migrate',
      `point ${req.current} -> ${outcome.artefactPath}`,
      'start launchd:org.example.prod-auth',
      'start docker:prod-api',
    ]);
    expect(outcome.artefactPath.endsWith(`/${named(STAGED)}`)).toBe(true);
    expect(outcome.record).toMatchObject({ version: STAGED, line: LINE, dryRun: false });
  });

  it('a refused migration promotes nothing and starts nothing, and says both are left stopped', () => {
    const { calls, effects } = watched([state(API, false), state(AUTH, false)], false);
    const outcome = promote(request(), effects);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toMatch(/left stopped/u);
    expect(calls).toEqual(['services', 'migrate']);
  });

  it('a real run needs the API, the auth server and the production link named', () => {
    for (const missing of ['api', 'auth', 'current'] as const) {
      const req = request();
      delete req[missing];
      const { calls, effects } = watched([state(API, false), state(AUTH, false)]);
      const outcome = promote(req, effects);
      expect(outcome.kind).toBe('refused');
      expect(calls).toEqual([]);
    }
    expect(existsSync(join(scratch, 'current'))).toBe(false);
  });
});

describe('S0-1 promotion needs operator authority', () => {
  it('a caller without operator authority is refused before migration', () => {
    const docker = fixture(
      'sol-operator-docker.json',
      JSON.stringify([{ Name: '/prod-api', State: { Running: false }, HostConfig: {} }]),
    );
    const launchd = fixture(
      'sol-operator-launchctl.txt',
      'PID\tStatus\tLabel\n-\t0\torg.example.prod-auth\n',
    );
    const result = run(
      [
        '--version',
        STAGED,
        '--artefacts',
        STORE(),
        '--line',
        LINE,
        '--api',
        'docker:prod-api',
        '--auth',
        'launchd:org.example.prod-auth',
        '--current',
        join(scratch, 'sol-operator-current'),
        '--docker-inspect',
        docker,
        '--launchctl',
        launchd,
      ],
      { DATABASE_ADMIN_URL: 'postgres://nobody@127.0.0.1:1/never' },
    );
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/operator|operations:manage|permission|authoris/iu);
    expect(result.out).not.toMatch(/db-migrate|ECONNREFUSED/iu);
  });

  // Criterion 14's proof runs past the operator gate as a signed-in operator,
  // in tests/ci/operator-only.test.ts.
});
