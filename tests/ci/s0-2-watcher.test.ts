// SPDX-License-Identifier: AGPL-3.0-only
// S0-2: the off-box watcher's plan, the alert channel and the test alert.
//
// `scripts/ops/alerts.mjs` is run as the owner runs it. `plan` prints what the
// watcher (UptimeRobot, off the machine) and the error sink (GlitchTip) are set
// up with: which addresses are checked and who is mailed. Every address comes
// from the environment at run time, never from the repository; the values
// here are made up. `test` sends one test alert to the error sink, which here
// is a fake sink on a loopback port: no real service is called.
import { execFile, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { plainAlert } from '../../apps/api/alerts/catalogue.ts';
import { NOT_PLAIN } from './s0-2-plain.ts';

const SCRIPT = 'scripts/ops/alerts.mjs';
const OWNER = 'owner@example.test';
const SECOND = 'second@example.test';
const TEST = 'alerts-test@example.test';
const BASE = {
  OPS_ALERT_OWNER_EMAIL: OWNER,
  OPS_ALERT_SECOND_OPERATOR_EMAIL: SECOND,
  OPS_ERROR_SINK_DSN: 'https://publickey@example.test/3',
  OPS_WATCH_STAGING_URL: 'https://staging.example.test/',
};

interface Monitor {
  readonly environment?: string;
  readonly watch: string;
  readonly type: string;
  readonly url?: string;
  readonly name: string;
  readonly message: string;
}
interface Plan {
  readonly channel: string;
  readonly recipients: readonly string[];
  readonly monitors: readonly Monitor[];
  readonly sink: { readonly recipients: readonly string[] };
}

function run(args: readonly string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    // Bounded: a run that wrongly reached the in-process fake sink would otherwise
    // block it (spawnSync holds this event loop) until fetch gave up.
    timeout: 10_000,
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function plan(env: Record<string, string>, args: readonly string[] = []): Plan {
  const result = run(['plan', ...args], env);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Plan;
}

describe('S0-2 uptime check off the machine for staging and production', () => {
  uptimeCheckOffCases1();
  uptimeCheckOffCases2();
});

function uptimeCheckOffCases1() {
  it('staging alone: its web page, its API health, its backup, forwarder and worker heartbeats, and the sink’s heartbeat', () => {
    const { monitors } = plan(BASE);
    expect(monitors.map((m) => [m.environment ?? '-', m.watch, m.type, m.url ?? '-'])).toEqual([
      ['staging', 'web', 'http', 'https://staging.example.test/'],
      ['staging', 'api', 'http', 'https://staging.example.test/api/health'],
      ['staging', 'backup', 'heartbeat', '-'],
      ['staging', 'restore', 'heartbeat', '-'],
      ['staging', 'forwarder', 'heartbeat', '-'],
      ['staging', 'worker', 'heartbeat', '-'],
      ['-', 'error sink', 'heartbeat', '-'],
    ]);
  });

  it('production joins once its address is set, at the first promotion', () => {
    const { monitors } = plan({ ...BASE, OPS_WATCH_PRODUCTION_URL: 'https://ops.example.test' });
    expect(
      monitors.filter((m) => m.environment === 'production').map((m) => m.url ?? m.type),
    ).toEqual([
      'https://ops.example.test/',
      'https://ops.example.test/api/health',
      'heartbeat',
      'heartbeat',
      'heartbeat',
      'heartbeat',
    ]);
  });
}

function uptimeCheckOffCases2() {
  it('an address the off-box watcher could not reach is refused, by name and without the value', () => {
    for (const url of [
      'http://staging.example.test/',
      'https://127.0.0.1:8790/',
      'https://localhost/',
      'https://10.1.2.3/',
      'https://192.168.1.20/',
      'https://172.20.0.4/',
      'https://m5.local/',
      'https://m5.LOCAL./',
      'https://LOCALHOST/',
      'https://localhost./',
      'https://2130706433/',
      'https://0x7f.0.0.1/',
      'https://[::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://169.254.169.254/',
      'https://100.64.0.1/',
      'https://db.internal/',
      'HTTP://staging.example.test/',
      'not a url',
    ]) {
      const result = run(['plan'], { ...BASE, OPS_WATCH_STAGING_URL: url });
      expect(result.status, url).toBe(1);
      expect(result.stderr).toMatch(/OPS_WATCH_STAGING_URL/u);
      expect(result.stderr).not.toContain(url);
    }
  });

  it('each monitor is named in plain words after what it is, never where it is', () => {
    const { monitors } = plan({ ...BASE, OPS_WATCH_PRODUCTION_URL: 'https://ops.example.test' });
    for (const monitor of monitors) {
      for (const pattern of NOT_PLAIN) {
        expect(monitor.name, monitor.watch).not.toMatch(pattern);
        expect(monitor.message, monitor.watch).not.toMatch(pattern);
      }
      expect(monitor.message.split('\n')[0]).toBe(`What broke: ${monitor.name}.`);
    }
    expect(monitors[1]?.message).toBe(plainAlert('api-down', 'staging').text);
    expect(monitors[1]?.name).toBe(plainAlert('api-down', 'staging').title);
  });
}

describe('S0-2 alerts go by email, at once, to the owner and the second operator', () => {
  it('the watcher and the sink each mail exactly the two operators, by their own mail', () => {
    const result = plan(BASE);
    expect(result.channel).toBe('email');
    expect(result.recipients).toEqual([OWNER, SECOND]);
    expect(result.sink.recipients).toEqual([OWNER, SECOND]);
  });

  it('a missing or malformed address is refused by name, and the value is not printed', () => {
    for (const name of ['OPS_ALERT_OWNER_EMAIL', 'OPS_ALERT_SECOND_OPERATOR_EMAIL']) {
      const missing = run(['plan'], { ...BASE, [name]: '' });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain(name);
      const bad = run(['plan'], { ...BASE, [name]: 'sk_live_planted' });
      expect(bad.status).toBe(1);
      expect(bad.stderr.includes('planted'), 'the value').toBe(false);
    }
  });
});

describe('S0-2 test alert reaches both operators on a test channel', () => {
  testAlertReachesCases1();
  testAlertReachesCases2();
  testAlertReachesCases3();
});

function testAlertReachesCases1() {
  it('the test channel sends everything to the agreed test address and nowhere else', () => {
    const result = plan({ ...BASE, OPS_ALERT_TEST_EMAIL: TEST }, ['--test']);
    expect(result.recipients).toEqual([TEST]);
    expect(result.sink.recipients).toEqual([TEST]);
    expect(run(['plan', '--test'], BASE).stderr).toContain('OPS_ALERT_TEST_EMAIL');
  });
}

/* eslint-disable max-lines-per-function -- one test, its body kept byte for byte */
function testAlertReachesCases2() {
  it('a test alert goes to the error sink in plain words, and the DSN is not printed', async () => {
    const received: { url: string; auth: string; body: Record<string, unknown> }[] = [];
    const server = createServer((request: IncomingMessage, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        received.push({
          url: request.url ?? '',
          auth: String(request.headers['x-sentry-auth']),
          body: JSON.parse(body) as Record<string, unknown>,
        });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const dsn = `http://fakekey@127.0.0.1:${port}/5`;
    try {
      // Check first, then act: a refused run sends nothing to the sink.
      const refused = { OPS_ERROR_SINK_DSN: dsn };
      for (const where of ['', 'prod']) {
        expect(run(['test'], { ...refused, OPS_ENVIRONMENT: where }).status).toBe(1);
      }
      const badRelease = { ...refused, OPS_ENVIRONMENT: 'staging', OPS_RELEASE: 'v1' };
      expect(run(['test'], badRelease).status).toBe(1);
      expect(received).toHaveLength(0);
      const env = {
        PATH: process.env['PATH'] ?? '',
        OPS_ERROR_SINK_DSN: dsn,
        OPS_ENVIRONMENT: 'staging',
      };
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [SCRIPT, 'test'], {
        env,
      });
      const result = { status: 0, out: stdout + stderr };
      expect(result.status).toBe(0);
      expect(result.out.includes('fakekey'), 'the key').toBe(false);
      expect(received).toHaveLength(1);
      expect(received[0]?.url).toBe('/api/5/store/');
      expect(received[0]?.auth).toContain('sentry_key=fakekey');
      expect(received[0]?.body).toMatchObject({
        level: 'warning',
        environment: 'staging',
        message: { formatted: plainAlert('test', 'staging').text },
      });
    } finally {
      await new Promise((resolve) => {
        server.close(resolve);
      });
    }
  });
}
/* eslint-enable max-lines-per-function */

function testAlertReachesCases3() {
  it('without a sink or an environment the test alert is refused by name', () => {
    const result = run(['test'], { OPS_ENVIRONMENT: 'staging' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('OPS_ERROR_SINK_DSN');
    expect(run(['test'], { OPS_ERROR_SINK_DSN: BASE.OPS_ERROR_SINK_DSN }).stderr).toContain(
      'OPS_ENVIRONMENT',
    );
  });
}
