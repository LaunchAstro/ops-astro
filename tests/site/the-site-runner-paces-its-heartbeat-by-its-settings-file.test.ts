// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's heartbeat on a free watcher (#2004): a pass runs every
// 15 s, so its settings file names the least time between two pings
// (`OPS_HEARTBEAT_EVERY_MS`), as the production worker and forwarder do. The
// setting is refused when malformed, in words naming it, never a value; unset,
// every pass pings as before.

import { describe, expect, it } from 'vitest';
import { heartbeat, passes } from '../../apps/site-runner/main.ts';
import { settingsFrom } from '../../apps/site-runner/settings.ts';

const SECRET = 'canary-password-7a20c4e1';
const BUSINESS = '6f1c2a54-9d0b-4c1e-8a7f-3b2d1e0f9a8c';
const GOOD = {
  OPS_ASTRO_API_URL: 'https://ops.example',
  OPS_ASTRO_BUSINESS: 'agency',
  OPS_ASTRO_BUSINESS_ID: BUSINESS,
  OPS_ASTRO_EMAIL: 'site-runner@example.com',
  OPS_ASTRO_PASSWORD: SECRET,
  OPS_ASTRO_GOTRUE_URL: 'https://auth.example',
  SITE_RUNNER_DATABASE_URL: `postgres://site_runner:${SECRET}@db.example:5432/postgres?sslmode=require`,
  SITE_RUNNER_CREDENTIALS_FILE: '/var/empty/site-credentials.json',
  SITE_RUNNER_SITE: JSON.stringify({
    business: BUSINESS,
    holder: BUSINESS,
    repository: 'LaunchAstro/agency-astro-astro',
    defaultBranch: 'main',
    project: 'prj_agency',
    pages: [{ pageUrl: 'https://agencyastro.com/about', path: 'src/pages/about.astro' }],
  }),
  SITE_RUNNER_HEARTBEAT_URL: `https://watch.example/api/0/organizations/agency/heartbeat/${SECRET}/`,
};

/** Passes 15 s apart for two minutes on a clock the test holds; the seconds each ping was sent at. */
async function pingsOverTwoMinutes(every?: string): Promise<number[]> {
  const settings = settingsFrom({ ...GOOD, OPS_HEARTBEAT_EVERY_MS: every });
  if (typeof settings === 'string') throw new Error(settings);
  let seconds = 0;
  const sent: number[] = [];
  const stopping = new AbortController();
  await passes({
    pass: () => Promise.resolve([]),
    ping: heartbeat(
      settings,
      (address) => {
        expect(address).toBe(GOOD.SITE_RUNNER_HEARTBEAT_URL);
        sent.push(seconds);
        return Promise.resolve('sent');
      },
      () => seconds * 1000,
    ),
    sleep: () => {
      seconds += 15;
      if (seconds > 120) stopping.abort();
      return Promise.resolve();
    },
    stopping: stopping.signal,
  });
  return sent;
}

describe('the site runner, its heartbeat on a free watcher', () => {
  it('pings no more often than its settings file says, though a pass runs every 15 s', async () => {
    expect(await pingsOverTwoMinutes('55000')).toEqual([0, 60, 120]);
  });

  it('pings after every pass when the pace is unset or empty', async () => {
    const everyPass = [0, 15, 30, 45, 60, 75, 90, 105, 120];
    expect(await pingsOverTwoMinutes()).toEqual(everyPass);
    expect(await pingsOverTwoMinutes('')).toEqual(everyPass);
  });

  it('refuses a pace that is not whole milliseconds or is over a day, naming no value', () => {
    const refusals = ['55s', '-1', '86400001'].map((every) =>
      settingsFrom({ ...GOOD, OPS_HEARTBEAT_EVERY_MS: every }),
    );
    expect(refusals).toEqual([
      'OPS_HEARTBEAT_EVERY_MS is not a whole number of milliseconds',
      'OPS_HEARTBEAT_EVERY_MS is not a whole number of milliseconds',
      'OPS_HEARTBEAT_EVERY_MS is more than a day',
    ]);
    expect(JSON.stringify(refusals)).not.toContain(SECRET);
  });
});
