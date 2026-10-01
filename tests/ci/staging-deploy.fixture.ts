// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-6 staging deploy suites' shared fixtures (staging-deploy.test.ts and
// staging-deploy-record.test.ts): the pinned compose file, fake effects and
// the operator the gate admits.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DeployEffects, type StagingDefinition } from '../../scripts/ops/deploy.ts';
import { afterAll } from 'vitest';

export const definition = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
) as StagingDefinition;

export const record: string = readFileSync(
  new URL('../../docs/supply-chain-pins.md', import.meta.url),
  'utf8',
);

export const STAGED = '0123456789ab';
/** The made-up-only preflight, answering clean: the deploy's own decisions are tested here. */
export const clean = (): Promise<string[]> => Promise.resolve([]);

export const BUILT: string = `sha256:${'a'.repeat(64)}`;

export const CANARY = 'canary-3be1d0-deploy-secret';

export const PG =
  'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';

export const scratch: string = mkdtempSync(join(tmpdir(), 's0-6d-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A definition with one pinned database and one app service, for the hostile cases. */
export const withImages = (images: Record<string, unknown>): StagingDefinition => ({
  ...definition,
  'x-ops-astro': { ...definition['x-ops-astro'], appServices: ['api'] },
  services: Object.fromEntries(
    Object.entries(images).map(([name, image]) => [
      name,
      image === undefined ? { container_name: `ops-astro-staging-${name}` } : { image },
    ]),
  ),
});

/** A snapshot as the service report prints it. */
export const snapshot = (services: readonly Record<string, unknown>[]): string =>
  JSON.stringify({ taken: '2026-09-29T00:00:00.000Z', services });

export const live: Readonly<Record<string, unknown>> = {
  manager: 'docker',
  name: 'prod-api',
  running: true,
  started: 't1',
  image: 'i',
  ports: [],
  config: 'c',
};

/** Each staging container and the image it should run: the built one for an app service. */
export const expected = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(definition.services).map(([name, s]) => [
      s.container_name,
      (definition['x-ops-astro'].appServices ?? []).includes(name) ? BUILT : String(s.image),
    ]),
  );

export interface Watched extends DeployEffects {
  readonly calls: string[];
}

/** Effects that record every call, answering as a healthy machine unless told otherwise. */
export function effects(over: Partial<DeployEffects> = {}): Watched {
  const calls: string[] = [];
  const base: DeployEffects = {
    snapshot: () => snapshot([live]),
    compare: (before, after) => ({ unchanged: before === after, report: 'compared' }),
    buildImage: () => BUILT,
    up: () => {},
    imageId: (ref) => ref,
    runningImages: () => expected(),
  };
  const watched = Object.fromEntries(
    Object.entries({ ...base, ...over }).map(([name, fn]) => [
      name,
      (...args: unknown[]) => {
        calls.push(name);
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as DeployEffects;
  return Object.assign(watched, { calls });
}
