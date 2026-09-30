// SPDX-License-Identifier: AGPL-3.0-only
// S0-1 and S0-2: the staging worker and its outbox forwarder, one unit on the
// machine, read from deploy/staging/compose.json. The production stop names the
// same pair (`scripts/ops/stop-production.mjs`). Containment and limits for
// every service, these two included, are staging-containment.test.ts.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

type Service = {
  image?: string;
  environment?: Record<string, string>;
  volumes?: string[];
  [key: string]: unknown;
};
const definition = () =>
  JSON.parse(read('deploy/staging/compose.json')) as { services: Record<string, Service> };
const names = (service: Service | undefined): string[] =>
  Object.keys(service?.environment ?? {}).toSorted();

it('S0-2 heartbeats: the worker and its forwarder are one unit, and the stop names it', () => {
  const { worker, forwarder } = definition().services;
  // One unit: the same pinned image and the same read-only code; starting the
  // forwarder starts the worker; the production stop names the pair.
  expect(worker?.image).toMatch(/^node:24-alpine@sha256:[0-9a-f]{64}$/u);
  expect(forwarder?.image).toBe(worker?.image);
  expect(forwarder?.volumes).toEqual(worker?.volumes);
  expect(worker?.volumes).toEqual(['ops-astro-staging-app:/app:ro']);
  expect(forwarder?.['depends_on']).toEqual({ worker: { condition: 'service_started' } });
  expect(read('scripts/ops/stop-production.mjs')).toContain(
    "const SERVICES = ['ops-astro-worker', 'ops-astro-forwarder'];",
  );
  // The worker holds no database; the forwarder holds its own login alone.
  expect(names(worker)).toEqual([
    'OPS_ASTRO_API_URL',
    'OPS_ASTRO_BUSINESS',
    'OPS_ASTRO_DELEGATION',
    'OPS_ASTRO_TOKEN',
    'OPS_WORKER_HEARTBEAT_URL',
  ]);
  expect(names(forwarder)).toEqual([
    'DATABASE_FORWARDER_URL',
    'OPS_ENVIRONMENT',
    'OPS_ERROR_SINK_DSN',
    'OPS_FORWARDER_HEARTBEAT_URL',
    'OPS_RELEASE',
  ]);
  expect(forwarder?.environment?.['OPS_ENVIRONMENT']).toBe('staging');
  expect(worker?.['command']).toEqual(['node', 'apps/worker/main.ts']);
  expect(forwarder?.['command']).toEqual(['node', 'scripts/ops/forwarder.mjs']);
  // The pin is recorded where every other image pin is.
  const digest = worker!.image!.split('@')[1];
  expect(read('docs/supply-chain-pins.md')).toMatch(
    new RegExp(`\\| \`node\`\\s+\\| \`24-alpine\`\\s+\\| \`${digest}\``, 'u'),
  );
});
