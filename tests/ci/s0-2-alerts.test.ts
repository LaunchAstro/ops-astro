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
  rebuiltError,
  sinkFrom,
} from '../../apps/api/alerts/sink.ts';
import { NOT_PLAIN } from './s0-2-plain.ts';
import { ROOT, fakeSink } from './s0-2-alerts.fixture.ts';

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
  errorsLandInCases1();
  errorsLandInCases2();
  errorsLandInBoundaryCases();
  errorsLandInCases3();
  errorsLandInCases4();
});

function errorsLandInCases1() {
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
      { filename: 'apps/api/app.ts', lineno: 231, in_app: true },
      { filename: 'packages/core-commands/src/reads/execute.ts', lineno: 40, in_app: true },
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
}

function errorsLandInCases2() {
  it('a thrown value that is not an Error, or a class name that is not a standard one, is reported as Error', () => {
    const odd = new Error('x');
    odd.name = 'Refused for jo@example.com';
    const named = new Error('x');
    named.name = 'PlantedWordsLettersOnly';
    class Custom extends Error {}
    for (const cause of [odd, named, new Custom('x'), 'a string', { secret: 'x' }, undefined]) {
      const event = errorEvent(cause, { where: 'production', root: ROOT });
      expect(event.exception?.values[0]?.type).toBe('Error');
    }
  });

  it('a thrown value whose name or stack cannot be read still reaches the sink, with no frames', async () => {
    const sink = fakeSink();
    const alerts = createAlerts({ send: sink.send, where: 'staging', root: ROOT });
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'stack', {
      get: () => {
        throw new Error('no');
      },
    });
    Object.defineProperty(hostile, 'name', {
      get: () => {
        throw new Error('no');
      },
    });
    const malformed = new Error('x');
    malformed.stack = 'Error: x\n    at f (file://%:1:1)\n    at g (file:///%E0%A4%A:2:2)';
    await alerts.fault(hostile);
    await alerts.fault(malformed);
    expect(sink.events.map((e) => e.exception?.values[0]?.stacktrace.frames)).toEqual([[], []]);
  });
}

function errorsLandInBoundaryCases() {
  it('refuses a private sink address before sending a key or an event', async () => {
    const asked: string[] = [];
    const fetchStub = ((url: string) => {
      asked.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    for (const host of ['127.0.0.1', '10.0.0.8', '169.254.169.254']) {
      // oxlint-disable-next-line no-await-in-loop -- each address is checked independently
      await expect(async () => {
        const send = dsnTransport(`https://canary@${host}/7`, fetchStub);
        await send(alertEvent('test', 'staging'));
      }).rejects.toThrow('OPS_ERROR_SINK_DSN');
    }
    expect(asked).toEqual([]);
  });

  it('does not follow a sink redirect with the key and event', async () => {
    const calls: RequestInit[] = [];
    const fetchStub = ((_url: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response('', { status: 302, headers: { location: 'https://elsewhere.test/' } }));
    }) as typeof fetch;
    const send = dsnTransport('https://canary@example.test/7', fetchStub);
    await expect(send(alertEvent('test', 'staging'))).rejects.toThrow();
    expect(['manual', 'error']).toContain(calls[0]?.redirect);
  });

  it('uses the forwarder release instead of an error row supplied release', () => {
    const event = rebuiltError(
      { release: 'deadbeefcafe', exception: { values: [{ type: 'Error' }] } },
      { where: 'staging', root: ROOT, release: 'abcdef012345' },
    );
    expect(event.release).toBe('abcdef012345');
  });
}

function errorsLandInCases3() {
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
}

function errorsLandInCases4() {
  it('a sink that is down never fails the request that reported to it', async () => {
    const alerts = createAlerts({
      send: () => Promise.reject(new Error('sink down')),
      where: 'staging',
      root: ROOT,
    });
    await expect(alerts.fault(new Error('boom'))).resolves.toBeUndefined();
  });
}
