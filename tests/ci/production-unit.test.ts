// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's M5 unit (deploy/production/compose.json): the worker, its
// forwarder, the backup store and the two egress hops, beside staging's. It is
// staging's definition with only the names changed, so every containment rule,
// limit, image pin and command staging's suites prove holds for it too
// (staging-containment.test.ts, staging-egress.test.ts). No production name or
// setting is staging's, and its worker unit is the pair production's stop
// names. `deploy.mjs --production` selects it.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type DeployEffects,
  definitionPath,
  deploy,
  imagePinProblems,
  productionAddressRefusal,
  type StagingDefinition,
  unitOf,
} from '../../scripts/ops/deploy.ts';
// @ts-expect-error -- the report is a plain JavaScript module, as the machine runs it
import * as report from '../../scripts/ops/service-report.mjs';
import { clean, effects, live, record, snapshot, STAGED, store } from './staging-deploy.fixture.ts';

const compare = (before: string, after: string, unit?: Parameters<DeployEffects['compare']>[2]) =>
  (report.compare as (...args: unknown[]) => ReturnType<DeployEffects['compare']>)(
    before,
    after,
    ...(unit === undefined ? [] : [unit]),
  );
const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const staging = (): StagingDefinition =>
  JSON.parse(read('deploy/staging/compose.json')) as StagingDefinition;
const production = (): StagingDefinition =>
  JSON.parse(read('deploy/production/compose.json')) as StagingDefinition;

/** Staging's definition with each name it owns changed to production's, and nothing else. */
function renamed(definition: StagingDefinition): unknown {
  return JSON.parse(
    JSON.stringify(definition)
      .replaceAll('ops-astro-staging', 'ops-astro')
      .replaceAll('ops_astro_staging', 'ops_astro')
      .replaceAll('${STAGING_', '${PRODUCTION_')
      .replaceAll('the staging runbook', 'the production runbook')
      .replaceAll('"staging"', '"production"')
      .replace('"madeUpDataOnly":true', '"madeUpDataOnly":false'),
  );
}

describe("production's M5 unit: staging's definition, renamed", () => {
  it('is staging’s definition with only the names changed', () => {
    expect(production()).toStrictEqual(renamed(staging()));
  });

  it('names nothing of staging’s: no container, network, volume or setting', () => {
    expect(read('deploy/production/compose.json')).not.toMatch(/staging/iu);
    const names = [
      ...Object.values(production().services).map((service) => service.container_name),
      production()['x-ops-astro'].ownPrefix,
    ];
    for (const name of names) expect(name).toMatch(/^ops-astro(?:-|$)/u);
  });

  it("its worker unit is the pair production's stop names", () => {
    const { worker, forwarder } = production().services;
    expect([worker?.container_name, forwarder?.container_name]).toStrictEqual([
      'ops-astro-worker',
      'ops-astro-forwarder',
    ]);
    expect(read('scripts/ops/stop-production.mjs')).toContain(
      "const SERVICES = ['ops-astro-worker', 'ops-astro-forwarder'];",
    );
    const environment = forwarder?.['environment'] as Record<string, string> | undefined;
    expect(environment?.['OPS_ENVIRONMENT']).toBe('production');
  });

  it('every service is named by a recorded digest', () => {
    expect(imagePinProblems(production(), record)).toStrictEqual([]);
  });
});

describe('the M5 deploy selects the unit by environment', () => {
  it("reads production's definition only with --production", () => {
    expect(definitionPath('production')).toMatch(/\/deploy\/production\/compose\.json$/u);
    expect(definitionPath('staging')).toMatch(/\/deploy\/staging\/compose\.json$/u);
  });

  it("checks production's own containers and records production", async () => {
    const running = Object.fromEntries(
      Object.values(production().services).map((s) => [s.container_name, String(s.image)]),
    );
    const outcome = await deploy(
      { version: STAGED, store: store() },
      effects({ runningImages: () => running }),
      clean,
      'production',
    );
    expect(outcome).toMatchObject({ kind: 'deployed', record: { environment: 'production' } });
  });

  it("fails when production's containers are not up, though staging's are", async () => {
    const outcome = await deploy(
      { version: STAGED, store: store() },
      effects(),
      clean,
      'production',
    );
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.reason).toContain('ops-astro-worker runs nothing');
    expect(outcome.kind === 'failed' && outcome.reason).toContain('Production is up');
  });

  it('a staging deploy records staging', async () => {
    const outcome = await deploy({ version: STAGED, store: store() }, effects(), clean);
    expect(outcome).toMatchObject({ kind: 'deployed', record: { environment: 'staging' } });
  });
});

const container = (name: string, started: string) => ({ ...live, name, started });
/** The machine with production's worker and staging's, each started at the time given. */
const machine = (worker: string, stagingWorker: string): string =>
  snapshot([
    live,
    container('ops-astro-worker', worker),
    container('ops-astro-staging-worker', stagingWorker),
  ]);

describe('each deploy leaves out its own containers and counts the other’s as live', () => {
  it("production's deploy restarts its own unit, never staging's", () => {
    const unit = unitOf('production');
    expect(compare(machine('t1', 't1'), machine('t2', 't1'), unit).unchanged).toBe(true);
    const restarted = compare(machine('t1', 't1'), machine('t1', 't2'), unit);
    expect(restarted.unchanged).toBe(false);
    expect(restarted.report).toContain('RESTARTED docker ops-astro-staging-worker');
    expect(restarted.report).toContain("production's own: ops-astro-worker");
  });

  it("staging's deploy restarts its own unit, never production's", () => {
    const unit = unitOf('staging');
    expect(compare(machine('t1', 't1'), machine('t1', 't2'), unit).unchanged).toBe(true);
    expect(compare(machine('t1', 't1'), machine('t2', 't1'), unit).unchanged).toBe(false);
    expect(compare(machine('t1', 't1'), machine('t2', 't1')).unchanged).toBe(false);
  });

  it('the deploy hands the compare its own unit', async () => {
    const units: string[] = [];
    const watched = effects({
      runningImages: () =>
        Object.fromEntries(
          Object.values(production().services).map((s) => [s.container_name, String(s.image)]),
        ),
      compare: (_before, _after, unit) => {
        units.push(unit.name);
        return { unchanged: true, report: '' };
      },
    });
    await deploy({ version: STAGED, store: store() }, watched, clean, 'production');
    expect(units).toStrictEqual(['production']);
  });
});

const STAGING = 'abcdefghijabcdefghij';
const PRODUCTION = 'zyxwvutsrqzyxwvutsrq';
const POOLER = 'aws-0-ap-southeast-2.pooler.supabase.com';
const address = (ref: string): string =>
  `postgresql://postgres.${ref}:secret@${POOLER}:5432/postgres`;

describe("production's preflight judges the address before it connects", () => {
  const env = (ref: string) => ({
    STAGING_PROJECT_REF: STAGING,
    PRODUCTION_PROJECT_REF: PRODUCTION,
    DATABASE_ADMIN_URL: address(ref),
  });

  it("refuses staging's database, or any but production's", () => {
    expect(productionAddressRefusal(env(STAGING))).toBe(
      "DATABASE_ADMIN_URL reaches staging's project",
    );
    expect(productionAddressRefusal(env('qqqqqqqqqqqqqqqqqqqq'))).toBe(
      "DATABASE_ADMIN_URL is not production's project",
    );
    expect(productionAddressRefusal({ ...env(PRODUCTION), STAGING_PROJECT_REF: '' })).toBe(
      'STAGING_PROJECT_REF is not set',
    );
    expect(productionAddressRefusal(env(PRODUCTION))).toBeUndefined();
  });
});
