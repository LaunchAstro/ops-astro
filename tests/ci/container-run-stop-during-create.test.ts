// SPDX-License-Identifier: AGPL-3.0-only
//
// A run stopped while docker is still making its container leaves none
// behind. The stand-in docker does what the real client does with its id
// file: it opens it empty before it asks for the container, writes the id
// once it has one, and deletes it when its create is cancelled or fails. It
// records each `kill` and `rm` it is asked for.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const bin = mkdtempSync(join(tmpdir(), 'container-run-'));
const calls = join(bin, 'calls');
const ID = 'a'.repeat(64);
afterAll(() => rmSync(bin, { recursive: true, force: true }));

type Run = { child: { spawnargs: string[] }; stop: () => Promise<void> };

/** A stand-in docker whose `run` does `create` (shell lines with $cid set), then waits to be stopped. */
function standIn(create: string[]): void {
  writeFileSync(calls, '');
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      `case "$1" in kill|rm) echo "$*" >> "${calls}"; exit 0 ;; esac`,
      'for arg in "$@"; do case $arg in --cidfile=*) cid="${arg#--cidfile=}" ;; esac; done',
      ': > "$cid"',
      `trap 'kill $child 2>/dev/null; rm -f "$cid"; exit 143' TERM`,
      ...create,
      '/bin/sleep 5 & child=$!',
      'wait $child',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
}

async function stopped(): Promise<{ name: string; folder: string; recorded: string }> {
  const path = process.env['PATH'];
  process.env['PATH'] = `${bin}:${path ?? ''}`;
  try {
    const module = '../../scripts/ops/container-run.mjs';
    const { runContainer } = (await import(
      /* @vite-ignore */
      module
    )) as { runContainer: (...args: unknown[]) => Run };
    const run = runContainer('store', 'none', { PGHOST: 'backups' }, ['psql']);
    const arg = (prefix: string) =>
      run.child.spawnargs.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? '';
    const cidfile = arg('--cidfile=');
    // Stop once docker has opened the id file: its create is under way.
    for (let tries = 0; tries < 100 && !existsSync(cidfile); tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- wait for the stand-in to open the file
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    await run.stop();
    return {
      name: arg('--name='),
      folder: join(cidfile, '..'),
      recorded: readFileSync(calls, 'utf8'),
    };
  } finally {
    process.env['PATH'] = path;
  }
}

it('a stop during create waits for the id, then cancels and removes that container', async () => {
  standIn(['/bin/sleep 0.3', `echo ${ID} > "$cid"`]);
  const { name, folder, recorded } = await stopped();
  expect(recorded).toBe(`kill --signal=INT ${ID}\nrm --force --volumes ${ID}\n`);
  expect(recorded).not.toContain(name);
  expect(existsSync(folder)).toBe(false);
}, 10_000);

it('a create that ends with no id while stopping removes the run by its own name, twice', async () => {
  standIn(['/bin/sleep 0.3', 'rm -f "$cid"', 'exit 125']);
  const { name, folder, recorded } = await stopped();
  expect(recorded).toBe(`rm --force --volumes ${name}\nrm --force --volumes ${name}\n`);
  expect(existsSync(folder)).toBe(false);
}, 10_000);
