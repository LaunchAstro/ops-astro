// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED: a pull request sent back for fixes runs no checks until its fix head, and no
// merge group is ever cancelled. The cases run the real script on the event file the runner
// writes; the wiring cases read the workflows as text.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { top } from './workflow-text.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'sent-back-hold-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the hold as the gate does, on `payload` written where GitHub writes the event. */
function hold(eventName: string, payload: unknown) {
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], GITHUB_EVENT_NAME: eventName };
  if (payload !== undefined) {
    const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, typeof payload === 'string' ? payload : JSON.stringify(payload));
    env['GITHUB_EVENT_PATH'] = path;
  }
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts/sent-back-hold.mjs')], {
    env,
    encoding: 'utf8',
  });
  return { status: run.status, out: run.stdout + run.stderr };
}

const pr = (action: string, label?: string, labels: string[] = []) => ({
  action,
  ...(label === undefined ? {} : { label: { name: label } }),
  pull_request: { number: 7, labels: labels.map((name) => ({ name })) },
});

describe('the sent-back hold', () => {
  it('fails the run the sent-back label starts, and says how to run the checks', () => {
    const run = hold('pull_request', pr('labeled', 'sent-back', ['sent-back']));
    expect(run.status).toBe(1);
    expect(run.out).toMatch(/sent back for fixes \(label 'sent-back'\)/u);
    expect(run.out).toMatch(/fix push runs every check; removing the label runs them now/u);
  });

  it('runs every check on the fix push, though the label is still on the pull request', () => {
    expect(hold('pull_request', pr('synchronize', undefined, ['sent-back'])).status).toBe(0);
  });

  it('runs every check when the label comes off, and on any other label', () => {
    expect(hold('pull_request', pr('unlabeled', 'sent-back')).status).toBe(0);
    expect(
      hold('pull_request', pr('labeled', 'needs-sol', ['sent-back', 'needs-sol'])).status,
    ).toBe(0);
    expect(hold('pull_request', pr('opened', undefined, ['sent-back'])).status).toBe(0);
    expect(hold('pull_request', pr('reopened', undefined, ['sent-back'])).status).toBe(0);
  });

  it('never holds a merge group or a push, whatever the event file says', () => {
    expect(hold('merge_group', pr('labeled', 'sent-back')).status).toBe(0);
    expect(hold('push', pr('labeled', 'sent-back')).status).toBe(0);
    expect(hold('pull_request_target', pr('labeled', 'sent-back')).status).toBe(0);
  });

  it('runs every check when it cannot read the event, so a mistake costs time, never a check', () => {
    expect(hold('pull_request', undefined).status).toBe(0);
    expect(hold('pull_request', '{not json').status).toBe(0);
    expect(hold('pull_request', null).status).toBe(0);
    expect(hold('pull_request', { action: 'labeled', label: 'sent-back' }).status).toBe(0);
    expect(hold('pull_request', pr('labeled', 'Sent-Back ')).status).toBe(0);
  });
});

describe('the workflows', () => {
  const ci = read('.github/workflows/ci.yml');
  const gate = top(ci, 'jobs').split(/^(?= {2}[\w-]+:$)/mu)[1] ?? '';

  it('the hold is the gate’s first check, with no condition, so it runs on every event', () => {
    expect(gate).toMatch(/^ {2}gate:$/mu);
    const steps = gate.split(/^(?= {6}- )/mu).slice(1);
    const at = steps.findIndex((s) => s.includes('run: node scripts/sent-back-hold.mjs'));
    expect(at).toBeGreaterThan(-1);
    // Only the checkout and the pinned Node run before it.
    expect(
      steps.slice(0, at).every((s) => /^ {6}- uses: actions\/(checkout|setup-node)@/u.test(s)),
    ).toBe(true);
    expect(steps[at]).not.toMatch(/^ {8}if:/mu);
    expect(steps[at]).not.toMatch(/continue-on-error/u);
  });

  it('a label event still starts a ci.yml run, so adding the label cancels the run in flight', () => {
    expect(top(ci, 'on')).toMatch(/^ {4}types: \[.*\blabeled\b.*\]$/mu);
  });

  it('a pull request cancels its own older run, and a merge group is never cancelled', () => {
    for (const path of [
      '.github/workflows/ci.yml',
      '.github/workflows/codeql.yml',
      '.github/workflows/review-evidence.yml',
    ]) {
      const block = top(read(path), 'concurrency');
      expect(block, path).toContain('  group: ${{ github.workflow }}-${{ github.ref }}\n');
      expect(block, path).toContain(
        "  cancel-in-progress: ${{ github.event_name != 'merge_group' }}\n",
      );
    }
  });
});
