// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner host's own rules (#1692), with no database: its settings
// file is refused when others can read it, when the database login does not
// require TLS or a page is not exact, and no refusal repeats a value; its
// heartbeat is pinged after each pass and goes quiet on a failed pass or once
// stopped; its plist keeps it alive from the build and names the label park
// and stop use.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { passes } from '../../apps/site-runner/main.ts';
import { readSettings, settingsFrom } from '../../apps/site-runner/settings.ts';

const SECRET = 'canary-password-5c1d0e77';
const GOOD = {
  OPS_ASTRO_API_URL: 'https://ops.example',
  OPS_ASTRO_BUSINESS: 'agency',
  OPS_ASTRO_BUSINESS_ID: '6f1c2a54-9d0b-4c1e-8a7f-3b2d1e0f9a8c',
  OPS_ASTRO_EMAIL: 'site-runner@example.com',
  OPS_ASTRO_PASSWORD: SECRET,
  OPS_ASTRO_GOTRUE_URL: 'https://auth.example',
  SITE_RUNNER_DATABASE_URL: `postgres://site_runner:${SECRET}@db.example:5432/postgres?sslmode=require`,
  SITE_RUNNER_CREDENTIALS_FILE: '/var/empty/site-credentials.json',
  SITE_RUNNER_PAGES: 'https://agencyastro.com/about',
};

const folder = mkdtempSync(join(tmpdir(), 'site-runner-settings-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function fileOf(name: string, body: unknown, mode: number): string {
  const file = join(folder, name);
  writeFileSync(file, JSON.stringify(body), { mode });
  chmodSync(file, mode);
  return file;
}

describe('the site runner, its settings', () => {
  it('reads a settings file only its owner can read', () => {
    const settings = readSettings({ SITE_RUNNER_SETTINGS: fileOf('own.json', GOOD, 0o600) });
    expect(typeof settings === 'string' ? settings : settings.pages).toEqual([
      'https://agencyastro.com/about',
    ]);
  });

  it('refuses a settings file others can read, and repeats no value in any refusal', () => {
    const refusals = [
      readSettings({ SITE_RUNNER_SETTINGS: fileOf('open.json', GOOD, 0o644) }),
      settingsFrom({
        ...GOOD,
        SITE_RUNNER_DATABASE_URL: GOOD.SITE_RUNNER_DATABASE_URL.split('?')[0],
      }),
      settingsFrom({ ...GOOD, SITE_RUNNER_PAGES: 'https://agencyastro.com/about/../about' }),
      settingsFrom({ ...GOOD, SITE_RUNNER_PAGES: 'http://agencyastro.com/about' }),
      settingsFrom({ ...GOOD, OPS_ASTRO_PASSWORD: '' }),
    ];
    expect(refusals).toEqual([
      'the settings file is readable by others',
      'SITE_RUNNER_DATABASE_URL does not require TLS (add ?sslmode=require or stricter)',
      'SITE_RUNNER_PAGES holds an address that is not an exact https page',
      'SITE_RUNNER_PAGES holds an address that is not an exact https page',
      'missing OPS_ASTRO_PASSWORD',
    ]);
    expect(JSON.stringify(refusals)).not.toContain(SECRET);
  });
});

describe('the site runner, its heartbeat', () => {
  it('pings after each pass, not after a failed one, and stops when asked', async () => {
    const stopping = new AbortController();
    const outcomes = [
      () => Promise.resolve([{ correctionId: 'c1', outcome: 'following' }]),
      () => Promise.reject(new Error('the database went away')),
      () => Promise.resolve([]),
    ];
    const pinged: number[] = [];
    let at = 0;
    await passes({
      pass: async () => await (outcomes[at] ?? (() => Promise.resolve([])))(),
      ping: () => {
        pinged.push(at);
        return Promise.resolve();
      },
      sleep: () => {
        at += 1;
        if (at === outcomes.length) stopping.abort();
        return Promise.resolve();
      },
      stopping: stopping.signal,
    });
    expect(pinged).toEqual([0, 2]);
    expect(at).toBe(outcomes.length);
  });
});

describe('the site runner, its plist', () => {
  it('keeps the runner alive from the build, under the label park and stop name', () => {
    const plist = readFileSync('deploy/m5/ops-astro-site-runner.plist', 'utf8');
    const runbook = readFileSync('apps/site-runner/RUNBOOK.md', 'utf8');
    expect(plist).toMatch(/<key>Label<\/key>\s*<string>ops-astro-site-runner<\/string>/u);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/u);
    expect(plist).toMatch(/<string>apps\/site-runner\/main\.ts<\/string>/u);
    expect(plist).toMatch(
      /<key>WorkingDirectory<\/key>\s*<string>@SITE_RUNNER_BUILD_DIR@<\/string>/u,
    );
    // Settings by file only: no secret is ever a plist value.
    expect(plist).not.toMatch(/PASSWORD|DATABASE_URL/u);
    expect(runbook).toContain('launchctl bootout gui/501/ops-astro-site-runner');
  });
});
