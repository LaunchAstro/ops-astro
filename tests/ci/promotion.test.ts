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
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseService,
  promote,
  type PromotionEffects,
  type PromotionRequest,
  type ServiceRef,
  type ServiceState,
} from '../../scripts/ops/promotion.ts';
import { outputDigest, recordedStamp } from '../../scripts/ops/build-output.ts';
import { LINE, named, NEWER, scratch, STAGED, staged, store, STORE } from './promotion.fixture.ts';
import { each } from './promotion.fixture.ts';

const COMMAND = new URL('../../scripts/ops/promote.mjs', import.meta.url).pathname;
const CANARY = 'canary-5d1e9a-promotion-secret';

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
    authorised: async (work) => await work(),
  };
  return { calls, effects };
};
const state = (ref: ServiceRef, running: boolean): ServiceState => ({ ...ref, running });
/** A request over `over.store` (STORE() unless given), with staging's record of each build it holds. */
const request = (over: Partial<PromotionRequest> = {}): PromotionRequest => {
  const root = over.store ?? STORE();
  const base = { version: STAGED, store: root, records: staged(root), line: LINE, dryRun: false };
  return { ...base, api: API, auth: AUTH, current: join(scratch, 'current'), ...over };
};

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
  it('the dry run picks the artefact the staging definition names and records its stamp', async () => {
    const { calls, effects } = watched([]);
    const outcome = await promote(request({ dryRun: true }), effects);
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

  it('never another build: a different stamp, no stamp, no artefact or a dirty build is refused', async () => {
    const cases: [Partial<PromotionRequest>, RegExp][] = [
      [{ store: store({ [named(STAGED)]: NEWER }) }, /carries fedcba987654, not 0123456789ab/u],
      [{ store: store({ [named(STAGED)]: null }) }, /carries no stamp/u],
      [{ store: store({ [named(NEWER)]: NEWER }) }, /no artefact ops-astro-0123456789ab/u],
      [{ version: `${STAGED}-dirty` }, /not a clean build identifier/u],
      [{ version: '../escape' }, /not a clean build identifier/u],
    ];
    await each(cases, async ([over, reason]) => {
      await each([true, false], async (dryRun) => {
        const { calls, effects } = watched([state(API, false), state(AUTH, false)]);
        const outcome = await promote(request({ ...over, dryRun }), effects);
        expect(outcome.kind).toBe('refused');
        if (outcome.kind === 'refused') expect(outcome.reason).toMatch(reason);
        expect(calls).toEqual([]);
      });
    });
  });

  it("records the owner's one line, and refuses without exactly one", async () => {
    await each(['', '   ', 'tried it\nand it was fine', 'x'.repeat(201)], async (line) => {
      const { calls, effects } = watched([]);
      const outcome = await promote(request({ line, dryRun: true }), effects);
      expect(outcome.kind).toBe('refused');
      if (outcome.kind === 'refused') expect(outcome.reason).toMatch(/one line/u);
      expect(calls).toEqual([]);
    });
  });
}

function promotionSameArtefactCases2() {
  it('the same bytes: an artefact changed after its digest, or recording none, is refused', async () => {
    const changed = STORE();
    writeFileSync(join(changed, named(STAGED), 'index.html'), '<p>another build</p>');
    const bare = STORE();
    writeFileSync(join(bare, named(STAGED), 'build.json'), JSON.stringify({ build: STAGED }));
    const cases = [
      [changed, /does not hold the bytes its digest records/u],
      [bare, /records no digest/u],
    ] as const;
    await each(cases, async ([root, reason]) => {
      await each([true, false], async (dryRun) => {
        const { calls, effects } = watched([state(API, false), state(AUTH, false)]);
        const outcome = await promote(request({ store: root, dryRun }), effects);
        expect(outcome).toMatchObject({ kind: 'refused', reason: expect.stringMatching(reason) });
        expect(calls).toEqual([]);
      });
    });
  });

  it('the command dry-runs over a store and prints the record, and nothing else', () => {
    const artefacts = STORE();
    const result = run(
      ['--dry-run', '--version', STAGED, '--artefacts', artefacts, '--line', LINE],
      {
        DATABASE_ADMIN_URL: `postgres://owner:${CANARY}@db.example/prod`,
        OPS_ASTRO_DEPLOYMENTS: staged(artefacts),
      },
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
  it('refuses while the API or the auth server runs, idle or not, says what to stop, and does nothing', async () => {
    const cases: [ServiceState[], RegExp][] = [
      [[state(API, true), state(AUTH, false)], /docker:prod-api is running/u],
      [[state(API, false), state(AUTH, true)], /launchd:org\.example\.prod-auth is running/u],
      [[state(API, true), state(AUTH, true)], /prod-api is running.*prod-auth is running/su],
      [[state(AUTH, false)], /cannot find docker:prod-api/u],
    ];
    await each(cases, async ([states, reason]) => {
      const { calls, effects } = watched(states);
      const outcome = await promote(request(), effects);
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') return;
      expect(outcome.reason).toMatch(reason);
      expect(outcome.reason).toMatch(/stop/iu);
      expect(calls).toEqual(['services']);
    });
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
  it('with both stopped: migrates, points production at the staged artefact, starts auth then API', async () => {
    const { calls, effects } = watched([state(API, false), state(AUTH, false)]);
    const req = request();
    const outcome = await promote(req, effects);
    expect(outcome.kind).toBe('promoted');
    if (outcome.kind !== 'promoted') return;
    expect(calls).toEqual([
      'services',
      'migrate',
      `point ${req.current} -> ${outcome.artefactPath}`,
      'start launchd:org.example.prod-auth',
      'start docker:prod-api',
    ]);
    // Production points at the copy, beside its link, named by the digest staging ran (#497).
    const digest = recordedStamp(join(req.store, named(STAGED))).digest;
    expect(outcome.artefactPath).toBe(
      join(dirname(req.current ?? ''), 'served', String(digest).slice(7)),
    );
    expect(outputDigest(outcome.artefactPath)).toBe(digest);
    expect(outcome.record).toMatchObject({ version: STAGED, line: LINE, dryRun: false });
  });

  it('a refused migration promotes nothing and starts nothing, and says both are left stopped', async () => {
    const { calls, effects } = watched([state(API, false), state(AUTH, false)], false);
    const outcome = await promote(request(), effects);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toMatch(/left stopped/u);
    expect(calls).toEqual(['services', 'migrate']);
  });

  it('a real run needs the API, the auth server and the production link named', async () => {
    await each(['api', 'auth', 'current'] as const, async (missing) => {
      const req = request();
      delete req[missing];
      const { calls, effects } = watched([state(API, false), state(AUTH, false)]);
      const outcome = await promote(req, effects);
      expect(outcome.kind).toBe('refused');
      expect(calls).toEqual([]);
    });
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
