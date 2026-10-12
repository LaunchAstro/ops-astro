// SPDX-License-Identifier: AGPL-3.0-only
//
// The release step checks the web build's stamp against this checkout, then
// copies the build and stamps the output. The check reads `dist/build.json`;
// the copy reads `dist` again later. Another build writing `dist` in between (a
// second `pnpm build`, from another revision) must not ship under the stamp
// that was checked. A release stopped part way, and run again, must leave one
// whole output, and a refused one must leave the output it found.

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildIdentifier, readStamp } from '../../apps/web/build-stamp.ts';
import { buildOutputProblems, recordedStamp } from '../../scripts/ops/build-output.ts';
import { release } from '../../scripts/ops/release.ts';

/** What the release's file calls do first, set by each case. */
const hooks = vi.hoisted(() => ({
  beforeRemove: undefined as ((path: string) => void) | undefined,
  beforeCopy: undefined as ((path: string) => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const rmSync: typeof real.rmSync = (path, options) => {
    hooks.beforeRemove?.(String(path));
    real.rmSync(path, options);
  };
  const cpSync: typeof real.cpSync = (source, destination, options) => {
    hooks.beforeCopy?.(String(source));
    real.cpSync(source, destination, options);
  };
  return { ...real, rmSync, cpSync, default: { ...real, rmSync, cpSync } };
});

const scratch = fs.mkdtempSync(join(tmpdir(), 'release-checked-'));
afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const STAMP = buildIdentifier(resolve(import.meta.dirname, '../..'));
/** A stamp of the right shape for a build from some other revision. */
const ELSEWHERE = 'abcdef012345';

function webBuild(name: string, stamp: string): string {
  const dist = join(scratch, name);
  fs.mkdirSync(join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(join(dist, 'index.html'), `<!doctype html><p>${stamp}</p>`);
  fs.writeFileSync(join(dist, 'build.json'), JSON.stringify({ build: stamp }));
  return dist;
}

describe('the release ships the web build it checked', () => {
  it('ships no web build under a stamp it did not carry when another build rewrites dist after the check', async () => {
    const dist = webBuild('raced', STAMP);
    const out = join(scratch, 'raced-out');
    hooks.beforeRemove = () => {
      hooks.beforeRemove = undefined;
      // The second writer: another revision's build lands in dist now.
      webBuild('raced', ELSEWHERE);
    };
    const outcome = await release({ dist, out }).catch((error: unknown) => error as Error);
    hooks.beforeRemove = undefined;
    if (outcome instanceof Error) {
      expect(outcome.message).toMatch(/not this checkout/u);
      return;
    }
    // The output's stamp names the web build it holds.
    expect(readStamp(join(out, 'static'))).toBe(recordedStamp(out).build);
  }, 300_000);

  it('a refused release leaves the output it found', async () => {
    const out = join(scratch, 'kept-out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(join(out, 'earlier'), 'the last good output');
    await expect(release({ dist: webBuild('other', ELSEWHERE), out })).rejects.toThrow(
      /not this checkout/u,
    );
    // Established: the check reads before anything is written.
    expect(fs.readFileSync(join(out, 'earlier'), 'utf8')).toBe('the last good output');
  });

  it('a release stopped while copying leaves no stamped output, and a rerun writes one whole', async () => {
    const dist = webBuild('stopped', STAMP);
    const out = join(scratch, 'stopped-out');
    hooks.beforeCopy = () => {
      hooks.beforeCopy = undefined;
      throw new Error('stopped');
    };
    await expect(release({ dist, out })).rejects.toThrow('stopped');
    // Established: nothing there carries a stamp a deploy would take.
    expect(recordedStamp(out).build).toBeUndefined();
    const record = await release({ dist, out });
    expect(record.build).toBe(STAMP);
    expect(readStamp(join(out, 'static'))).toBe(STAMP);
    expect(recordedStamp(out)).toStrictEqual(record);
    expect(buildOutputProblems(out)).toStrictEqual([]);
  }, 300_000);
});
