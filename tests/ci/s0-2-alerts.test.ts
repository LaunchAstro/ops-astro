// SPDX-License-Identifier: AGPL-3.0-only
// S0-2: alerts in plain words, the error sink and the security detections.
//
// One case per line of the ticket's supporting checklist that code can hold.
// The watcher and the sink are the owner's services (UptimeRobot and
// GlitchTip); nothing here reaches either. The sink is a fake transport that
// keeps what it was handed, and the watcher's plan is read, not registered.
import { describe, expect, it } from 'vitest';
import { ALERT_KINDS, plainAlert } from '../../apps/api/alerts/catalogue.ts';
import {
  alertEvent,
  createAlerts,
  dsnTransport,
  errorEvent,
  sinkFrom,
  type SinkEvent,
} from '../../apps/api/alerts/sink.ts';
import { NOT_PLAIN } from './s0-2-plain.ts';
import { createDetector, type SecuritySignal } from '../../apps/api/alerts/detect.ts';

const ROOT = process.cwd();

function fakeSink(): {
  readonly events: SinkEvent[];
  readonly send: (e: SinkEvent) => Promise<void>;
} {
  const events: SinkEvent[] = [];
  return { events, send: (event) => Promise.resolve(void events.push(event)) };
}

function detectorFor(start = 0) {
  let now = start;
  const raised: string[] = [];
  const detector = createDetector((kind) => raised.push(kind), { now: () => now });
  return { raised, observe: detector.observe, detector, advance: (ms: number) => (now += ms) };
}

describe('S0-2 plain words: each alert names what broke, what it affects and what happens next', () => {
  for (const kind of ALERT_KINDS) {
    for (const where of ['staging', 'production'] as const) {
      it(`${kind} on ${where}`, () => {
        const alert = plainAlert(kind, where);
        const lines = alert.text.split('\n');
        expect(lines.map((line) => line.split(':')[0])).toEqual([
          'What broke',
          'What it affects',
          'What happens next',
        ]);
        for (const line of lines) expect(line.split(': ')[1]?.length).toBeGreaterThan(10);
        expect(alert.title.length).toBeGreaterThan(10);
        for (const pattern of NOT_PLAIN) {
          expect(alert.text, `${kind} ${pattern}`).not.toMatch(pattern);
          expect(alert.title, `${kind} ${pattern}`).not.toMatch(pattern);
        }
      });
    }
  }
});

describe('S0-2 errors land in the error sink', () => {
  it('an application error becomes one event: its class, in-app frames and the plain words, never its message', async () => {
    const sink = fakeSink();
    const alerts = createAlerts({
      send: sink.send,
      where: 'staging',
      release: 'abcdef012345',
      root: ROOT,
    });
    const cause = new TypeError('the value was sk_live_planted');
    cause.stack = [
      'TypeError: the value was sk_live_planted',
      `    at readTask (${ROOT}/packages/core-commands/src/reads/execute.ts:40:11)`,
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
      `    at file://${ROOT}/apps/api/app.ts:231:20`,
      '    at /opt/vendor/lib.js:1:1',
    ].join('\n');
    await alerts.fault(cause);
    expect(sink.events).toHaveLength(1);
    const [event] = sink.events;
    const exception = event?.exception?.values[0];
    expect(exception?.type).toBe('TypeError');
    expect(exception?.value).toBe(plainAlert('app-error', 'staging').text);
    expect(exception?.stacktrace.frames).toEqual([
      { filename: 'apps/api/app.ts', function: '?', lineno: 231, in_app: true },
      {
        filename: 'packages/core-commands/src/reads/execute.ts',
        function: 'readTask',
        lineno: 40,
        in_app: true,
      },
    ]);
    expect(event).toMatchObject({
      level: 'error',
      environment: 'staging',
      release: 'abcdef012345',
    });
    expect(JSON.stringify(event).includes('planted'), 'the message').toBe(false);
  });

  it('a message that forges a frame line cannot put its content in a frame', async () => {
    const sink = fakeSink();
    const alerts = createAlerts({ send: sink.send, where: 'staging', root: ROOT });
    const forged = `    at leak (${ROOT}/Juniper-Vale-owes-money.ts:1:1)`;
    const cause = new Error(`first line\n${forged}`);
    await alerts.fault(cause);
    expect(cause.stack).toContain('Juniper');
    expect(JSON.stringify(sink.events).includes('Juniper'), 'forged content').toBe(false);
    expect(sink.events[0]?.exception?.values[0]?.stacktrace.frames.length).toBeGreaterThan(0);
  });

  it('a thrown value that is not an Error, or a class name that is not a name, is reported as Error', () => {
    const odd = new Error('x');
    odd.name = 'Refused for jo@example.com';
    for (const cause of [odd, 'a string', { secret: 'x' }, undefined]) {
      const event = errorEvent(cause, { where: 'production', root: ROOT });
      expect(event.exception?.values[0]?.type).toBe('Error');
    }
  });

  it('the transport posts to the sink store named by the DSN, the key in the auth header only', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchStub = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    const send = dsnTransport('https://publickey@example.test/7', fetchStub);
    await send(alertEvent('test', 'staging'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.test/api/7/store/');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('x-sentry-auth')).toContain('sentry_key=publickey');
    expect(String(calls[0]?.init.body).includes('publickey'), 'the key').toBe(false);
  });

  it('a malformed setting is refused by name, never skipped', () => {
    const dsn = 'https://publickey@example.test/7';
    expect(sinkFrom({})).toBeUndefined();
    expect(sinkFrom({ OPS_ERROR_SINK_DSN: dsn, OPS_ENVIRONMENT: 'staging' })?.where).toBe(
      'staging',
    );
    for (const where of [undefined, '', 'Staging', 'prod']) {
      expect(() => sinkFrom({ OPS_ERROR_SINK_DSN: dsn, OPS_ENVIRONMENT: where })).toThrow(
        /^OPS_ENVIRONMENT/u,
      );
    }
    for (const release of ['v1.2.3', 'ABCDEF012345', 'abcdef012345 ', 'abcdef01234']) {
      const environment = {
        OPS_ERROR_SINK_DSN: dsn,
        OPS_ENVIRONMENT: 'staging',
        OPS_RELEASE: release,
      };
      expect(() => sinkFrom(environment), release).toThrow(/^OPS_RELEASE/u);
    }
  });

  it('a DSN that is not one is refused by name, never echoed', () => {
    expect(() => dsnTransport('not a dsn sk_live_planted')).toThrow(/^OPS_ERROR_SINK_DSN/u);
    try {
      dsnTransport('ftp://k@x/1');
    } catch (error) {
      expect(String(error)).not.toContain('ftp');
    }
  });

  it('a sink that is down never fails the request that reported to it', async () => {
    const alerts = createAlerts({
      send: () => Promise.reject(new Error('sink down')),
      where: 'staging',
      root: ROOT,
    });
    await expect(alerts.fault(new Error('boom'))).resolves.toBeUndefined();
  });
});

describe('S0-2 security alerts (TR-SEC-9): one detection each', () => {
  const alpha = { business: 'alpha' } as const;

  it('S0-2 security: repeated failed sign-ins raise one alert', () => {
    const d = detectorFor();
    const failed: SecuritySignal = { kind: 'sign-in-failed', ...alpha, person: 'mia' };
    for (let i = 0; i < 4; i += 1) d.observe(failed);
    expect(d.raised).toEqual([]);
    d.observe(failed);
    expect(d.raised).toEqual(['sign-in-failures']);
    d.observe(failed);
    expect(d.raised, 'one alert per burst, not one per attempt').toHaveLength(1);
  });

  it('S0-2 security: failed sign-ins spread past the window raise nothing', () => {
    const d = detectorFor();
    for (let i = 0; i < 10; i += 1) {
      d.observe({ kind: 'sign-in-failed', ...alpha, person: 'mia' });
      d.advance(4 * 60_000);
    }
    expect(d.raised).toEqual([]);
  });

  it('S0-2 security: a permission, grant or custody change raises an alert at once', () => {
    const d = detectorFor();
    d.observe({ kind: 'authority-changed', ...alpha });
    expect(d.raised).toEqual(['authority-changed']);
  });

  it('S0-2 security: a failed secret scan raises an alert at once', () => {
    const d = detectorFor();
    d.observe({ kind: 'secret-scan-failed' });
    expect(d.raised).toEqual(['secret-scan-failed']);
  });

  it('S0-2 security: a burst of cross-scope refusals raises one alert', () => {
    const d = detectorFor();
    for (let i = 0; i < 9; i += 1)
      d.observe({ kind: 'cross-scope-refusal', ...alpha, person: 'mia' });
    expect(d.raised).toEqual([]);
    d.observe({ kind: 'cross-scope-refusal', ...alpha, person: 'mia' });
    expect(d.raised).toEqual(['cross-scope-burst']);
  });

  it('S0-2 security: repeated webhook signature failures raise one alert', () => {
    const d = detectorFor();
    const bad: SecuritySignal = { kind: 'webhook-signature-failed', ...alpha, source: 'xero' };
    for (let i = 0; i < 5; i += 1) d.observe(bad);
    expect(d.raised).toEqual(['webhook-signature-failures']);
  });

  it('S0-2 security: unusual export or download volume raises one alert', () => {
    const d = detectorFor();
    d.observe({ kind: 'export', ...alpha, client: 'c1', items: 150 });
    expect(d.raised).toEqual([]);
    d.observe({ kind: 'export', ...alpha, client: 'c1', items: 50 });
    expect(d.raised).toEqual(['export-volume']);
  });

  it('each raised detection reaches the sink as a warning in plain words', async () => {
    const sink = fakeSink();
    const alerts = createAlerts({ send: sink.send, where: 'production', root: ROOT });
    alerts.observe({ kind: 'secret-scan-failed' });
    await alerts.settled();
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      level: 'warning',
      message: { formatted: plainAlert('secret-scan-failed', 'production').text },
      tags: { alert: 'secret-scan-failed' },
    });
  });

  it('the detector forgets expired scopes, so many one-off callers cannot grow it without bound', () => {
    const d = detectorFor();
    for (let i = 0; i < 20_000; i += 1) {
      d.observe({ kind: 'sign-in-failed', ...alpha, person: `p${i}` });
      if (i % 1000 === 0) d.advance(60 * 60_000);
    }
    expect(d.raised).toEqual([]);
    expect(d.detector.tracked()).toBeLessThanOrEqual(10_001);
  });
});
