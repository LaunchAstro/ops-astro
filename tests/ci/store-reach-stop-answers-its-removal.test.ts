// SPDX-License-Identifier: AGPL-3.0-only
//
// A reach that stops its own run, at its deadline or because the caller's
// line handler threw, answers that stop's removal: when docker keeps
// refusing to remove the container, the reach fails naming it, even though
// the client then closed cleanly. The stand-in docker keeps each container
// as a file holding its login; every `rm` is refused and the container kept;
// the client prints 1, then closes with 0 once the first removal is asked.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const bin = mkdtempSync(join(tmpdir(), 'store-reach-stop-'));
const calls = join(bin, 'calls');
const containers = join(bin, 'containers');
const ID = 'c'.repeat(64);
const STORE = 'postgres://upkeep:fixture-only@backups/store';
const path = process.env['PATH'];

type Reach = (
  url: string,
  script: string,
  onLine?: (line: string) => Promise<void> | void,
) => Promise<string>;

beforeAll(() => {
  process.env['PATH'] = `${bin}:${path ?? ''}`;
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      `if [ "$1" = rm ]; then echo "$*" >> "${calls}"; echo 'Error response from daemon: transient' >&2; exit 1; fi`,
      `if [ "$1" = kill ]; then echo "$*" >> "${calls}"; exit 0; fi`,
      'for arg in "$@"; do case $arg in --cidfile=*) cid="${arg#--cidfile=}" ;; esac; done',
      `echo ${ID} > "$cid"`,
      `printf 'Running PGPASSWORD=%s\\n' "$PGPASSWORD" > "${containers}/${ID}"`,
      `echo created >> "${calls}"`,
      'cat > /dev/null',
      'echo 1',
      `while ! grep -q '^rm ' "${calls}"; do /bin/sleep 0.05; done`,
      `echo client-closes-0 >> "${calls}"`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
  // The first run of a new executable can be held for checks; take it before any deadline counts.
  execFileSync(join(bin, 'docker'), ['kill', 'warm-up']);
});

beforeEach(() => {
  writeFileSync(calls, '');
  rmSync(containers, { recursive: true, force: true });
  mkdirSync(containers);
});

afterAll(() => {
  process.env['PATH'] = path;
  rmSync(bin, { recursive: true, force: true });
  // A run whose removal was refused can keep its id file; clear only this file's.
  for (const entry of readdirSync(tmpdir())) {
    const cid = join(tmpdir(), entry, 'cid');
    if (
      entry.startsWith('ops-astro-run-') &&
      existsSync(cid) &&
      readFileSync(cid, 'utf8').trim() === ID
    ) {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    }
  }
});

async function psqlOn(bounds?: { timeoutMs?: number }): Promise<Reach> {
  const module = '../../scripts/ops/backup-store-reach.mjs';
  const reach = (await import(
    /* @vite-ignore */
    module
  )) as { psqlOn: (network: string, bounds?: { timeoutMs?: number }) => Reach };
  return reach.psqlOn('none', bounds);
}

/** What the reach answered, and the docker calls once the stop's two rounds of removal are in. */
async function outcomeOf(
  reached: Promise<string>,
): Promise<{ outcome: { answered: string } | { failed: string }; order: string[] }> {
  const outcome = await reached.then(
    (answered) => ({ answered }),
    (error: unknown) => ({ failed: (error as Error).message }),
  );
  // A reach that answers before its stop is done leaves removals still to come: wait for them, bounded.
  let order: string[] = [];
  for (let tries = 0; tries < 400; tries += 1) {
    order = readFileSync(calls, 'utf8').trim().split('\n');
    if (order.filter((line) => line.startsWith('rm ')).length >= 6) break;
    // oxlint-disable-next-line no-await-in-loop -- wait for the stand-in to record the removals
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return { outcome, order };
}

function expectKeptAndStoppedById(order: string[]): void {
  expect(order.slice(0, 3)).toEqual([
    'created',
    `kill --signal=INT ${ID}`,
    `rm --force --volumes ${ID}`,
  ]);
  expect(order).toContain('client-closes-0');
  // The stop's removal by id, then asked again after the clean close: three tries each.
  expect(order.filter((line) => line.startsWith('rm '))).toHaveLength(6);
  expect(readFileSync(join(containers, ID), 'utf8')).toContain('PGPASSWORD=fixture-only');
}

it('a reach stopped at its deadline fails naming the container docker would not remove, though the client closed cleanly', async () => {
  const bounded = await psqlOn({ timeoutMs: 300 });
  const { outcome, order } = await outcomeOf(bounded(STORE, 'select 1;\n'));
  expectKeptAndStoppedById(order);
  expect(outcome).toEqual({
    failed: expect.stringContaining(`docker would not remove container ${ID}`),
  });
}, 30_000);

it('a reach stopped because its line handler threw fails naming the container docker would not remove', async () => {
  const reach = await psqlOn();
  const { outcome, order } = await outcomeOf(
    reach(STORE, 'select 1;\n', () => {
      throw new Error('the caller refused the line');
    }),
  );
  expectKeptAndStoppedById(order);
  expect(outcome).toEqual({
    failed: expect.stringContaining(`docker would not remove container ${ID}`),
  });
}, 30_000);
