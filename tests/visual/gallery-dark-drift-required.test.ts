// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readPacket } from './packet.ts';
import { addressOf, builtPages, needsSession, report, type PageShot } from './report.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

it('MP-1-1 a missing dark screenshot cannot count as a captured page', () => {
  const packet = readPacket();
  const page = builtPages()[0];
  if (page === undefined) throw new Error('the route registry has no page to capture');
  const absent = `sol-absent-${page}@390-dark.page.png`;
  const shots: PageShot[] = [{ page, width: 390, theme: 'dark', picture: absent, overflow: 0 }];

  const result = report({ ...packet, widths: [390] }, [page], shots);
  expect(result.lines).toContain(`FAIL ${page}@390-dark: no picture`);
});

it('MP-1-1 required app drift proves the signed-in gallery in dark at every width', () => {
  const catalogue = JSON.parse(read('tests/visual/states.json')) as {
    appDrift?: { page: string; theme: string; control: string; token: string };
  };
  expect(catalogue.appDrift).toMatchObject({ page: 'agency:gallery', theme: 'dark' });
  expect(catalogue.appDrift?.control).toMatch(/\S/u);
  expect(catalogue.appDrift?.token).toMatch(/^--[\w-]+$/u);
  expect(addressOf('agency:gallery', {})).toBe('/gallery/');
  expect(needsSession('agency:gallery')).toBe(true);

  const workflow = read('.github/workflows/ci.yml');
  const job = workflow.split(/^  visual-drift:\s*$/mu)[1]?.split(/^  [\w-]+:\s*$/mu)[0] ?? '';
  expect(job, 'the required visual drift job is missing').toMatch(/name: visual drift/u);
  expect(job).toMatch(/node tests\/visual\/app-drift-cases\.ts/u);
  const command =
    job
      .replaceAll(/\\\n\s*/gu, ' ')
      .split('\n')
      .find((line) => line.includes('node tests/visual/run.ts --app-drift')) ?? '';
  expect(command).toMatch(/--app\s+\S+/u);
  expect(command).toMatch(/--session\s+\S+/u);
  expect(command).not.toMatch(/--page\b|--theme\b/u);

  const runner = read('tests/visual/run.ts');
  const mode = runner.indexOf("if (args.includes('--app-drift'))");
  const mockup = runner.indexOf("const mockupDir = process.env['MOCKUP_DIR']");
  expect(mode, 'app drift must run without a private mockup').toBeGreaterThanOrEqual(0);
  expect(mockup).toBeGreaterThan(mode);
  expect(runner).toMatch(/if \(needsSession\(page\) && session === undefined\)/u);
  expect(runner).toMatch(/await appDrift\(\{ app, session, drift/u);

  for (const file of ['tests/visual/app-drift.ts', 'tests/visual/app-drift-cases.ts']) {
    expect(existsSync(join(root, file)), `${file} must be in the public tree`).toBe(true);
  }
  const capture = read('tests/visual/capture.ts');
  expect(capture).toMatch(/document\.documentElement\.getAttribute\('data-theme'\)/u);
  expect(capture).toMatch(/drawn !== side\.theme/u);
  const appDrift = read('tests/visual/app-drift.ts');
  expect(appDrift).toMatch(/for \(const width of packet\.widths\)/u);
  expect(appDrift).toMatch(/colorScheme: drift\.theme/u);
  expect(appDrift).toContain('drawn in dark, not as light');
  expect(appDrift).toMatch(/await proveDrift\([\s\S]*?token: drift\.token/u);
  const cases = read('tests/visual/app-drift-cases.ts');
  expect(cases).toMatch(/2 \* widths/u);
  expect(cases).toContain('drawn in dark, not as light');
});
