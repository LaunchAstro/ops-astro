// SPDX-License-Identifier: AGPL-3.0-only
//
// The security gate reads a scanner that failed quietly as a refusal, never as
// a clean scan. With no exception recorded, an audit that counted no
// dependencies or carries no count, advisories that are not keyed by id, an advisory whose severity the gate does not know, and a
// Semgrep report whose scanned field is anything but a list of paths are each
// refused. The real gate runs on each report, beside a complete report that
// passes.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');

/** The gate's exit status on `report`, with empty exception lists. */
function gate(kind: string, report: object): number | null {
  const dir = mkdtempSync(join(tmpdir(), 'security-gate-scan-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const [r, x] = [join(dir, 'report.json'), join(dir, 'exceptions.json')];
  writeFileSync(r, JSON.stringify(report));
  writeFileSync(x, JSON.stringify({ audit: [], semgrep: [] }));
  const args = ['scripts/security-gate.mjs', kind, '--report', r, '--exceptions', x];
  return spawnSync('node', [...args, '--root', dir], { cwd: ROOT }).status;
}

const audit = (totalDependencies: number, severity?: string) => ({
  advisories:
    severity === undefined
      ? {}
      : { 1: { github_advisory_id: 'GHSA-0', module_name: 'm', severity } },
  metadata: { totalDependencies },
});
const semgrep = (scanned: unknown) => ({ results: [], errors: [], paths: { scanned } });

it('an audit that counted no dependencies, or names an unknown severity, is refused', () => {
  const cases = {
    'a complete audit': gate('audit', audit(812)),
    'a low advisory': gate('audit', audit(812, 'low')),
    'no dependencies counted': gate('audit', audit(0)),
    'no dependency count at all': gate('audit', { advisories: {} }),
    'advisories as a list': gate('audit', { ...audit(812), advisories: [] }),
    'an unknown severity': gate('audit', audit(812, 'urgent')),
    'a severity in capitals': gate('audit', audit(812, 'HIGH')),
  };
  expect(cases).toEqual({
    'a complete audit': 0,
    'a low advisory': 0,
    'no dependencies counted': 1,
    'no dependency count at all': 1,
    'advisories as a list': 1,
    'an unknown severity': 1,
    'a severity in capitals': 1,
  });
});

it('a Semgrep report whose scanned field is not a list of paths is refused', () => {
  const cases = {
    'a list of paths': gate('semgrep', semgrep(['a.ts'])),
    'an object': gate('semgrep', semgrep({ 'a.ts': true })),
    'one path as a string': gate('semgrep', semgrep('a.ts')),
    'a list holding no path': gate('semgrep', semgrep([42])),
    'a list holding an empty path': gate('semgrep', semgrep([''])),
  };
  expect(cases).toEqual({
    'a list of paths': 0,
    'an object': 1,
    'one path as a string': 1,
    'a list holding no path': 1,
    'a list holding an empty path': 1,
  });
});
