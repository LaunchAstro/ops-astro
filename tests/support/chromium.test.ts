// SPDX-License-Identifier: AGPL-3.0-only
//
// On Linux, Playwright starts Chromium with --disable-dev-shm-usage, so its
// shared memory is made as `.org.chromium.Chromium.*` files in the temp folder.
// A Chromium process that ends while making one leaves it there, and on
// 30 September 2026 two such files failed the temp guard (CI run 36719343211).
// These prove the one door every browser in the run goes through: its own
// temp folder, removed once the browser is closed, whatever Chromium left.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Browser, LaunchOptions } from 'playwright';
import { expect, it } from 'vitest';
import { launchChromium, type Launcher } from './chromium.ts';

const ROOT = join(import.meta.dirname, '../..');

/** A launcher that records what it was given and leaves a shared-memory file behind, as Chromium can. */
function leavingLauncher(close: () => Promise<void> = () => Promise.resolve()) {
  const given: LaunchOptions[] = [];
  const launcher: Launcher = {
    launch: (options?: LaunchOptions) => {
      given.push(options ?? {});
      const temp = options?.env?.['TMPDIR'];
      if (temp !== undefined) writeFileSync(join(temp, '.org.chromium.Chromium.a1B2c3'), '');
      return Promise.resolve({ close } as unknown as Browser);
    },
  };
  return { launcher, given };
}

const tempOf = (options: LaunchOptions | undefined): string => options?.env?.['TMPDIR'] ?? '';

it('a browser the run starts makes its temp files in a folder of its own, and closing it removes what Chromium left', async () => {
  const { launcher, given } = leavingLauncher();
  const first = await launchChromium({ headless: true }, launcher);
  const second = await launchChromium({ headless: true }, launcher);
  const [a, b] = [tempOf(given[0]), tempOf(given[1])];

  expect(given[0]?.headless).toBe(true);
  expect(given[0]?.env?.['PATH']).toBe(process.env['PATH']);
  expect(relative(tmpdir(), a)).toMatch(/^chromium-/u);
  expect(b).not.toBe(a);
  expect(readdirSync(a)).toEqual(['.org.chromium.Chromium.a1B2c3']);

  await first.close();
  await second.close();
  expect(existsSync(a)).toBe(false);
  expect(existsSync(b)).toBe(false);
});

it('a browser whose close fails still has its temp folder removed', async () => {
  const { launcher, given } = leavingLauncher(() => Promise.reject(new Error('browser gone')));
  const browser = await launchChromium({}, launcher);
  const temp = tempOf(given[0]);
  expect(existsSync(temp)).toBe(true);

  await expect(browser.close()).rejects.toThrow('browser gone');
  expect(existsSync(temp)).toBe(false);
});

it('a browser that fails to start leaves no temp folder behind', async () => {
  const given: LaunchOptions[] = [];
  const launcher: Launcher = {
    launch: (options?: LaunchOptions) => {
      given.push(options ?? {});
      return Promise.reject(new Error('no executable'));
    },
  };
  await expect(launchChromium({}, launcher)).rejects.toThrow('no executable');
  const temp = tempOf(given[0]);
  expect(relative(tmpdir(), temp)).toMatch(/^chromium-/u);
  expect(existsSync(temp)).toBe(false);
});

it('every browser the vitest run starts goes through launchChromium', () => {
  // tests/browser/*.mjs are the browser acceptance harness, run by their own
  // CI step outside vitest and outside the temp guard.
  const direct = listed('tests')
    .filter((file) => /\.tsx?$/u.test(file) && file !== 'tests/support/chromium.ts')
    .filter((file) =>
      /\bchromium\s*\.\s*launch\s*\(/u.test(readFileSync(join(ROOT, file), 'utf8')),
    );
  expect(direct).toEqual([]);
});

function listed(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listed(path);
    return [path];
  });
}
