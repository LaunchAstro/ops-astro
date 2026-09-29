// SPDX-License-Identifier: AGPL-3.0-only
// Review proofs for S0-2 at 23457e0. These tests intentionally fail on that head.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  createApi,
  type AgentExecutor,
  type CommandExecutor,
  type ReadExecutor,
} from '../../apps/api/app.ts';
import { createAlerts, type SinkEvent } from '../../apps/api/alerts/sink.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { PREFIX, pathOf } from '../../packages/core-wire/src/index.ts';
import { times } from './s0-2-plain.ts';

const ROOT = process.cwd();

it('Sol proof, criterion 4: planted words in an error name and forged in-app frame never reach the sink', async () => {
  const events: SinkEvent[] = [];
  const alerts = createAlerts({
    where: 'staging',
    root: ROOT,
    send: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  });
  const cause = new Error('a fault');
  cause.name = 'CanarySecretLettersOnly';
  cause.stack = `Error: a fault\n    at JuniperValeOwesMoney (${ROOT}/apps/api/app.ts:1:1)`;
  await alerts.fault(cause);
  expect(events).toHaveLength(1);
  const sent = JSON.stringify(events);
  expect({
    secretInSink: sent.includes('CanarySecretLettersOnly'),
    recordInSink: sent.includes('JuniperValeOwesMoney'),
  }).toEqual({ secretInSink: false, recordInSink: false });
});

it('Sol proof, criterion 6: a malformed stack frame cannot prevent an application error reaching the sink', async () => {
  const events: SinkEvent[] = [];
  const alerts = createAlerts({
    where: 'staging',
    root: ROOT,
    send: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  });
  const cause = new Error('a fault');
  cause.stack = 'Error: a fault\n    at forged (file://%:1:1)';
  await alerts.fault(cause);
  expect(events).toHaveLength(1);
  expect(events[0]?.level).toBe('error');
});

it('Sol proof, criterion 7: the watcher plan carries effects and next steps for its alerts', () => {
  const result = spawnSync(process.execPath, ['scripts/ops/alerts.mjs', 'plan'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      OPS_ALERT_OWNER_EMAIL: 'owner@example.test',
      OPS_ALERT_SECOND_OPERATOR_EMAIL: 'second@example.test',
      OPS_ERROR_SINK_DSN: 'https://publickey@example.test/3',
      OPS_WATCH_STAGING_URL: 'https://staging.example.test/',
    },
  });
  expect(result.status).toBe(0);
  const plan = JSON.parse(result.stdout) as { monitors: unknown[] };
  expect(plan.monitors.length).toBeGreaterThan(0);
  for (const monitor of plan.monitors) {
    const configured = JSON.stringify(monitor);
    expect(configured, 'watcher effect').toContain('What it affects');
    expect(configured, 'watcher next step').toContain('What happens next');
  }
});

it('Sol proof, criterion 10: every security detection has a production signal source', () => {
  const sourceFiles = ['apps', 'packages', 'scripts'].flatMap((directory) =>
    readdirSync(resolve(ROOT, directory), { recursive: true })
      .map((relative) => resolve(ROOT, directory, String(relative)))
      .filter(
        (file) =>
          /\.(?:ts|tsx|mjs|js)$/u.test(file) &&
          !file.endsWith('/apps/api/alerts/detect.ts') &&
          statSync(file).isFile(),
      ),
  );
  const production = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  const missing = ['secret-scan-failed', 'webhook-signature-failed', 'export'].filter(
    (kind) => !production.includes(`kind: '${kind}'`),
  );
  expect(missing).toEqual([]);
});

it('Sol proof, criterion 10: repeated agent cross-business refusals raise a burst alert', async () => {
  const events: SinkEvent[] = [];
  const alerts = createAlerts({
    where: 'staging',
    root: ROOT,
    send: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  });
  const unused = (() => Promise.resolve({ code: 'ok' })) as unknown as CommandExecutor;
  const businesses: Record<string, string> = { own: 'id' };
  const api = createApi({
    database: {} as Database,
    verify: () => Promise.resolve({ provider: 'test', subject: 'agent-one' }),
    resolveBusiness: (key) => Promise.resolve(businesses[key]),
    executeRead: unused as unknown as ReadExecutor,
    executeCommand: unused,
    executeAgentCommand: unused as unknown as AgentExecutor,
    observe: alerts.observe,
  });
  await times(10, async () => {
    const response = await api.fetch(
      new Request(`http://api.test${PREFIX.agent}foreign${pathOf('task.update')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(401);
  });
  await alerts.settled();
  expect(events.map((event) => event.tags['alert'])).toEqual(['cross-scope-burst']);
});
