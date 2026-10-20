// SPDX-License-Identifier: AGPL-3.0-only
//
// The worker runs without a heartbeat address and pings nothing
// (`apps/worker/heartbeat.ts` `ping`, `apps/worker/main.ts` `refusal`), so the
// real Compose interpolation of production's base and worker file takes the
// worker's heartbeat empty or unset. Every other setting the worker file
// requires is still refused empty, by name.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORKER_UNIT } from './staging-placeholders.fixture.ts';

const base = new URL('../../deploy/production/compose.json', import.meta.url).pathname;
const worker = new URL('../../deploy/production/worker.json', import.meta.url).pathname;

const HEARTBEAT = 'PRODUCTION_WORKER_HEARTBEAT_URL';

const settings: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(WORKER_UNIT).map(([key, value]) => [
      key.replace('STAGING_', 'PRODUCTION_'),
      value,
    ]),
  ),
  PRODUCTION_BACKUPS_ADMIN_USER: 'probe',
  PRODUCTION_BACKUPS_ADMIN_PASSWORD: 'probe-only',
};

/** `docker compose config` over the base and the worker file: its JSON, or its refusal's words. */
function config(env: Readonly<Record<string, string>>): { definition?: unknown; refused?: string } {
  try {
    const out = execFileSync(
      'docker',
      ['compose', '-f', base, '-f', worker, 'config', '--format', 'json'],
      {
        env: { PATH: process.env['PATH'], HOME: process.env['HOME'], ...env },
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { definition: JSON.parse(out) };
  } catch (error) {
    return { refused: String((error as { stderr?: unknown }).stderr ?? error) };
  }
}

const workerHeartbeat = (definition: unknown): unknown =>
  (definition as { services: { worker: { environment: Record<string, unknown> } } } | undefined)
    ?.services.worker.environment['OPS_WORKER_HEARTBEAT_URL'];

/** Every setting the worker file requires, as it names them. */
const required = [...readFileSync(worker, 'utf8').matchAll(/\$\{(PRODUCTION_[A-Z_]+):\?/gu)].map(
  (match) => match[1] as string,
);

describe("production's worker file under the real Compose", () => {
  it('starts the worker with its heartbeat address empty or unset', () => {
    const empty = config({ ...settings, [HEARTBEAT]: '' });
    const { [HEARTBEAT]: _unset, ...withoutIt } = settings;
    const unset = config(withoutIt);

    expect({
      empty: [empty.refused, workerHeartbeat(empty.definition)],
      unset: [unset.refused, workerHeartbeat(unset.definition)],
    }).toStrictEqual({ empty: [undefined, ''], unset: [undefined, ''] });
  });

  it('still refuses each other setting it requires, empty, by name', () => {
    expect(required).not.toContain(HEARTBEAT);
    expect(required).toContain('PRODUCTION_WORKER_DELEGATION');
    const unrefused = required.filter(
      (name) => config({ ...settings, [name]: '' }).refused?.includes(name) !== true,
    );

    expect(unrefused).toStrictEqual([]);
  });
});
