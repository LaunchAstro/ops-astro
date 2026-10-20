// SPDX-License-Identifier: AGPL-3.0-only
//
// The maintenance deployment (ticket S0-6's owner check and case R8; the
// promotion's first step under O-1): one static page for every path, put on
// the main address the same prebuilt way as the web deploy, with no database
// asked, and watched by its own alert, which fires while the page answers 200.
// The planned form names the version whose deploy takes the page off and runs
// that deploy's checks first (#1985); the bare form, for an incident, says it
// ran none. `vercel` is the fixture's fake (web-deploy.fixture.ts). The operator gate in
// front of the command is proved in operator-only.test.ts.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { plainAlert } from '../../apps/api/alerts/catalogue.ts';
import { MAINTENANCE_MARKER, writeMaintenanceOutput } from '../../scripts/ops/maintenance.ts';
import { deployMaintenance } from '../../scripts/ops/web-deploy.ts';
import {
  authReads,
  CANARY,
  clean,
  fakeVercel,
  folder,
  settings,
  STAGED,
  store,
  URL_MADE,
} from './web-deploy.fixture.ts';

describe('S0-6 maintenance deployment', () => {
  maintenanceOutputCase();
  maintenanceDeployCases();
  plannedMaintenanceCases();
  plannedProductionCase();
  plannedMaintenanceGreenCase();
  runbookWindowCase();
  maintenanceAlertCases();
});

function maintenanceOutputCase() {
  it('is static pages only, every path to the one page, which carries the marker and nothing else to run', () => {
    const out = folder('maintenance');
    writeMaintenanceOutput(out);
    expect(existsSync(join(out, 'functions'))).toBe(false);
    const config = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')) as unknown;
    expect(config).toStrictEqual({
      version: 3,
      routes: [{ handle: 'filesystem' }, { src: '^/.*$', dest: '/index.html' }],
    });
    const page = readFileSync(join(out, 'static', 'index.html'), 'utf8');
    expect(page).toContain(MAINTENANCE_MARKER);
    expect(page).toMatch(/maintenance/iu);
    expect(page).not.toMatch(/<script|https?:|src=|href=/iu);
  });
}

function maintenanceDeployCases() {
  it('bare, goes to the main address prebuilt, never asks the database, records the deployment and says it checked no deploy', async () => {
    const vercel = fakeVercel();
    const outcome = await deployMaintenance({ env: settings(vercel.path) });
    expect(outcome).toMatchObject({
      kind: 'deployed',
      record: { action: 'maintenance recorded', deployment: URL_MADE },
    });
    expect(outcome.kind === 'deployed' && outcome.record).toStrictEqual({
      action: 'maintenance recorded',
      deployment: URL_MADE,
    });
    expect(outcome.kind === 'deployed' && outcome.unchecked).toMatch(
      /^no version was named, so the deploy that takes the page off was not checked/u,
    );
    expect(vercel.lines('argv')).toStrictEqual(['deploy --prebuilt --prod']);
    expect(vercel.lines('page')[0]).toContain(MAINTENANCE_MARKER);
    expect(readFileSync(vercel.log, 'utf8')).not.toContain(CANARY);
    expect(existsSync(vercel.lines('cwd')[0]!)).toBe(false);
  });

  it('a token, a bad project id or no deployment address records nothing', async () => {
    for (const [over, deploy] of [
      [{ VERCEL_TOKEN: CANARY }, undefined],
      [{ VERCEL_PROJECT_ID: 'prj_' }, undefined],
      [{}, { out: 'Error', status: 1 }],
    ] as const) {
      const vercel = fakeVercel(deploy === undefined ? {} : { deploy });
      // oxlint-disable-next-line no-await-in-loop -- each case on its own
      const outcome = await deployMaintenance({ env: { ...settings(vercel.path), ...over } });
      expect(outcome.kind, JSON.stringify(over)).not.toBe('deployed');
      expect(JSON.stringify(outcome)).not.toContain(CANARY);
    }
  });
}

const sign = (): Promise<string[]> => Promise.resolve(['a view over a private table']);

function plannedMaintenanceCases() {
  it('named with the version that takes it off, refuses on a missing key, a missing artefact, a failing preflight or a silent sign-in server, deploying nothing', async () => {
    const cases = [
      [
        'no key',
        store(),
        { SUPABASE_PUBLISHABLE_KEY: '' },
        clean,
        /SUPABASE_PUBLISHABLE_KEY is not set/u,
      ],
      ['no artefact', folder('empty-store'), {}, clean, /no artefact /u],
      [
        'preflight',
        store(),
        {},
        sign,
        /staging's database failed the preflight: a view over a private table/u,
      ],
      [
        'auth silent',
        store(),
        { GOTRUE_URL: 'http://127.0.0.1:1/auth/v1' },
        clean,
        /did not report its version/u,
      ],
    ] as const;
    for (const [name, at, over, preflight, problem] of cases) {
      const vercel = fakeVercel();
      const env = { ...settings(vercel.path), ...over };
      const reads = authReads();
      // oxlint-disable-next-line no-await-in-loop -- each case on its own
      const outcome = await deployMaintenance(
        { env },
        { request: { version: STAGED, store: at }, options: { env, preflight } },
      );
      expect(outcome.kind, name).toBe('refused');
      expect(outcome.kind === 'refused' && outcome.reason, name).toMatch(problem);
      expect(outcome.kind === 'refused' && outcome.reason, name).toMatch(
        /Nothing was deployed\.$/u,
      );
      expect(JSON.stringify(outcome), name).not.toContain(CANARY);
      expect(existsSync(vercel.log), name).toBe(false);
      if (name !== 'auth silent') expect(authReads(), name).toBe(reads);
    }
  });
}

function plannedProductionCase() {
  it("named for production, applies production's checks as its deploy does", async () => {
    const vercel = fakeVercel();
    const env = settings(vercel.path);
    const outcome = await deployMaintenance(
      { env },
      {
        request: { version: STAGED, store: store() },
        options: { env, preflight: clean, environment: 'production' },
      },
    );
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toMatch(/held grant/u);
    expect(existsSync(vercel.log)).toBe(false);
  });
}

function plannedMaintenanceGreenCase() {
  it('named with the version that takes it off and every check green, deploys the page and records it as today', async () => {
    const vercel = fakeVercel();
    const env = settings(vercel.path);
    const reads = authReads();
    const outcome = await deployMaintenance(
      { env },
      { request: { version: STAGED, store: store() }, options: { env, preflight: clean } },
    );
    expect(outcome).toStrictEqual({
      kind: 'deployed',
      record: { action: 'maintenance recorded', deployment: URL_MADE },
    });
    expect(vercel.lines('argv')).toStrictEqual(['deploy --prebuilt --prod']);
    expect(vercel.lines('page')[0]).toContain(MAINTENANCE_MARKER);
    expect(authReads()).toBe(reads + 1);
  });
}

function runbookWindowCase() {
  it('the staging and production runbooks open a migrate window with the planned form', () => {
    for (const [runbook, form] of [
      ['deploy/staging/README.md', '--maintenance --version <id> --artefacts <store>`'],
      [
        'deploy/production/README.md',
        '--maintenance --version <id> --artefacts <store> --production`',
      ],
    ] as const) {
      const text = readFileSync(runbook, 'utf8');
      const start = text.indexOf('### How a migrate window drains');
      const window = text.slice(start, text.indexOf('\n#', start + 1));
      expect(start, runbook).toBeGreaterThan(-1);
      expect(window.replaceAll('\n', ' '), runbook).toContain(form);
    }
  });
}

function maintenanceAlertCases() {
  it('the watcher alerts while the maintenance page answers: a keyword check for its marker, per place', () => {
    const result = spawnSync(process.execPath, ['scripts/ops/alerts.mjs', 'plan'], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        OPS_ALERT_OWNER_EMAIL: 'owner@example.test',
        OPS_ALERT_SECOND_OPERATOR_EMAIL: 'second@example.test',
        OPS_ERROR_SINK_DSN: 'https://publickey@example.test/3',
        OPS_WATCH_STAGING_URL: 'https://staging.example.test/',
        OPS_WATCH_PRODUCTION_URL: 'https://ops.example.test/',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const { monitors } = JSON.parse(result.stdout) as { monitors: Record<string, unknown>[] };
    const watching = monitors.filter((m) => m['watch'] === 'maintenance');
    expect(watching.map((m) => m['environment'])).toStrictEqual(['staging', 'production']);
    expect(watching).toStrictEqual(
      (['staging', 'production'] as const).map((where) => ({
        environment: where,
        watch: 'maintenance',
        type: 'keyword',
        url: where === 'staging' ? 'https://staging.example.test/' : 'https://ops.example.test/',
        keyword: MAINTENANCE_MARKER,
        alertWhen: 'exists',
        name: plainAlert('maintenance-on', where).title,
        message: plainAlert('maintenance-on', where).text,
      })),
    );
  });

  it("the app's own pages never carry the marker, so the check is quiet while the app serves", () => {
    const listed = spawnSync('git', ['grep', '-l', '-F', MAINTENANCE_MARKER, '--', 'apps'], {
      encoding: 'utf8',
    });
    expect(listed.stdout).toBe('');
    expect(MAINTENANCE_MARKER).toMatch(/^[a-z-]{16,}$/u);
  });
}
