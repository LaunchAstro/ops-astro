// SPDX-License-Identifier: AGPL-3.0-only
// S0-2: the security detections (TR-SEC-9), one case per detection.
//
// The detector runs on a hand clock; nothing here reaches the sink or the
// watcher. The alert words and the error sink are in s0-2-alerts.test.ts.

import { describe, expect, it } from 'vitest';
import { plainAlert } from '../../apps/api/alerts/catalogue.ts';
import { createAlerts } from '../../apps/api/alerts/sink.ts';
import { type SecuritySignal } from '../../apps/api/alerts/detect.ts';
import { ROOT, fakeSink, detectorFor, alpha } from './s0-2-alerts.fixture.ts';

describe('S0-2 security alerts (TR-SEC-9): one detection each', () => {
  securityAlertsTrCases1();
  securityAlertsTrCases2();
});

function securityAlertsTrCases1() {
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

  it('S0-2 security: a scope cannot be spelt from another, whatever characters a key carries', () => {
    const d = detectorFor();
    for (let i = 0; i < 4; i += 1) {
      d.observe({ kind: 'sign-in-failed', business: 'alpha\u0000mia', person: 'x' });
    }
    d.observe({ kind: 'sign-in-failed', business: 'alpha', person: 'mia\u0000x' });
    d.observe({ kind: 'sign-in-failed', business: 'alpha","mia', person: 'x' });
    d.observe({ kind: 'sign-in-failed', business: 'alpha\u0001mia', person: 'x' });
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
}

function securityAlertsTrCases2() {
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
    d.observe({ kind: 'export', ...alpha, who: 'c1', items: 4000 });
    expect(d.raised).toEqual([]);
    d.observe({ kind: 'export', ...alpha, who: 'c1', items: 1000 });
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
}
