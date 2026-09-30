// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-1 egress allow-list, one source for each place (REVB1SL01S34B finding 1).
// The relay's API place is the worker's own STAGING_WEB_URL, and the relay
// refuses to start unless its API alias is that host. The relay lists host
// names only, so the worker, the forwarder and the backup dump each refuse to
// start when an address of theirs would leave anywhere but the egress host
// setting beside it. Refusals name settings, never values.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { offEgress } from '../../apps/worker/heartbeat.ts';

type EgressModule = { allowList: (env: Record<string, string>) => [string, number][] };
const EGRESS = '../../scripts/ops/egress.mjs';
const { allowList } = (await import(
  /* @vite-ignore */
  EGRESS
)) as EgressModule;

const ROOT = resolve(import.meta.dirname, '../..');
const BEAT = 'beat.example.test';
const POOLER = 'pooler.example.test';
const ELSEWHERE = 'elsewhere.example.test';
const CANARY = 'canary-one-source-4e1d';
const LIST = {
  STAGING_WEB_URL: 'https://api.example.test',
  OPS_EGRESS_POOLER_HOST: POOLER,
  OPS_EGRESS_POOLER_PORT: '6543',
  OPS_EGRESS_HEARTBEAT_HOST: BEAT,
  OPS_EGRESS_SINK_HOST: 'sink.example.test',
};

const start = (script: string, args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });

describe('S0-1 egress allow-list: one source for each place', () => {
  relayCases();
  helperCase();
  consumerCases();
  missingSettingCases();
});

function relayCases() {
  it("the API is the worker's own address or nothing: https, port 443, a host alone", () => {
    for (const bad of [
      `http://${CANARY}.example.test`,
      `https://${CANARY}.example.test:8443`,
      `https://user:pass@${CANARY}.example.test`,
      `https://${CANARY}.example.test/elsewhere`,
      `https://${CANARY}.example.test?x=1`,
    ]) {
      expect(() => allowList({ ...LIST, STAGING_WEB_URL: bad }), bad).toThrow(/^STAGING_WEB_URL /u);
      expect(() => allowList({ ...LIST, STAGING_WEB_URL: bad })).not.toThrow(CANARY);
    }
    const [api] = allowList({ ...LIST, STAGING_WEB_URL: 'https://API.example.test:443/' });
    expect(api).toEqual(['api.example.test', 443]);
  });

  it("the relay refuses to start unless its API alias is the worker's host", () => {
    const relay = start('scripts/ops/egress.mjs', ['relay'], {
      ...LIST,
      OPS_EGRESS_API_ALIAS: `${CANARY}.example.test`,
    });
    expect(relay.status).toBe(1);
    expect(relay.stderr).toContain('OPS_EGRESS_API_ALIAS is not the host of STAGING_WEB_URL');
    expect(relay.stderr.includes(CANARY)).toBe(false);
  });
}

function helperCase() {
  it('an address on the listed host and port passes; anywhere else is named, never shown', () => {
    const judge = (address: string, port?: string) =>
      offEgress(
        { ...LIST, A: address, P: port },
        port === undefined
          ? [['A', 'OPS_EGRESS_HEARTBEAT_HOST']]
          : [['A', 'OPS_EGRESS_POOLER_HOST', 'P']],
      );
    expect(judge(`https://${BEAT}/${CANARY}`)).toBe(undefined);
    expect(judge(`https://${BEAT.toUpperCase()}:443/x`)).toBe(undefined);
    expect(judge(`postgres://${POOLER}:6543/postgres`, '6543')).toBe(undefined);
    for (const [address, port] of [
      [`https://${ELSEWHERE}/${CANARY}`],
      [`https://${BEAT}:8443/${CANARY}`],
      [`https://${BEAT}.${ELSEWHERE}/${CANARY}`],
      [`https://${BEAT}@${ELSEWHERE}/${CANARY}`],
      [`not an address ${CANARY}`],
      [`postgres://${POOLER}/postgres`, '6543'],
      [`postgres://${POOLER}:6544/postgres`, '6543'],
    ] as const) {
      const message = judge(address, port);
      expect(message, address).toMatch(/^A does not leave by OPS_EGRESS_/u);
      expect(message?.includes(CANARY)).toBe(false);
    }
  });

  it('a missing egress host or port setting is a refusal, never a skipped check', () => {
    const a = { A: `https://${ELSEWHERE}/${CANARY}` };
    expect(offEgress(a, [['A', 'UNSET_HOST']])).toBe('A is set but UNSET_HOST is not');
    expect(offEgress({ ...a, H: ELSEWHERE }, [['A', 'H', 'UNSET_PORT']])).toBe(
      'A is set but UNSET_PORT is not',
    );
    // An address that is unset leaves by nothing: there is nothing to judge.
    expect(offEgress({}, [['A', 'UNSET_HOST']])).toBe(undefined);
  });
}

function consumerCases() {
  it('the worker refuses to start when its heartbeat would leave by another host', () => {
    const run = start('apps/worker/main.ts', ['--once'], {
      OPS_ASTRO_API_URL: 'http://127.0.0.1:1',
      OPS_ASTRO_BUSINESS: 'alpha',
      OPS_ASTRO_TOKEN: 'unused',
      OPS_ASTRO_DELEGATION: 'unused',
      OPS_WORKER_HEARTBEAT_URL: `https://${ELSEWHERE}/${CANARY}`,
      OPS_EGRESS_HEARTBEAT_HOST: BEAT,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('OPS_WORKER_HEARTBEAT_URL does not leave by');
    expect(run.stderr.includes(CANARY)).toBe(false);
  });

  it('the forwarder refuses to start when its database login would leave by another pooler', () => {
    const run = start('scripts/ops/forwarder.mjs', ['--once'], {
      DATABASE_FORWARDER_URL: `postgres://127.0.0.1:1/${CANARY}`,
      OPS_ERROR_SINK_DSN: 'https://made-up-key@example.test/7',
      OPS_ENVIRONMENT: 'staging',
      OPS_RELEASE: '0123456789ab',
      OPS_EGRESS_POOLER_HOST: POOLER,
      OPS_EGRESS_POOLER_PORT: '6543',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('DATABASE_FORWARDER_URL does not leave by OPS_EGRESS_POOLER_HOST');
    expect(run.stderr.includes(CANARY)).toBe(false);
  });

  it('the backup run refuses its source off the listed pooler as a config failure', () => {
    const run = start('scripts/ops/backup.mjs', ['run'], {
      BACKUP_SOURCE_URL: `postgres://backup:unused@${ELSEWHERE}:5432/${CANARY}`,
      BACKUP_STORE_URL: 'postgres://store:unused@backups:5432/none',
      BACKUP_PUBLIC_KEY_FILE: resolve(ROOT, 'package.json'),
      OPS_EGRESS_POOLER_HOST: POOLER,
      OPS_EGRESS_POOLER_PORT: '5432',
    });
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ outcome: 'failed', stage: 'config' });
    expect(run.stdout.includes(CANARY)).toBe(false);
  });
}

function missingSettingCases() {
  it('the worker and the forwarder refuse to start when their egress setting is missing', () => {
    const worker = start('apps/worker/main.ts', ['--once'], {
      OPS_ASTRO_API_URL: 'http://127.0.0.1:1',
      OPS_ASTRO_BUSINESS: 'alpha',
      OPS_ASTRO_TOKEN: 'unused',
      OPS_ASTRO_DELEGATION: 'unused',
      OPS_WORKER_HEARTBEAT_URL: `https://${BEAT}/${CANARY}`,
    });
    expect(worker.status).toBe(2);
    expect(worker.stderr).toContain(
      'OPS_WORKER_HEARTBEAT_URL is set but OPS_EGRESS_HEARTBEAT_HOST is not',
    );
    const forwarder = start('scripts/ops/forwarder.mjs', ['--once'], {
      DATABASE_FORWARDER_URL: `postgres://${POOLER}:6543/${CANARY}`,
      OPS_ERROR_SINK_DSN: 'https://made-up-key@example.test/7',
      OPS_ENVIRONMENT: 'staging',
      OPS_RELEASE: '0123456789ab',
    });
    expect(forwarder.status).toBe(1);
    expect(forwarder.stderr).toContain(
      'DATABASE_FORWARDER_URL is set but OPS_EGRESS_POOLER_HOST is not',
    );
    for (const run of [worker, forwarder]) expect(run.stderr.includes(CANARY)).toBe(false);
  });
}
