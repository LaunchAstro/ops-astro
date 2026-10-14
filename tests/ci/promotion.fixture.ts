// SPDX-License-Identifier: AGPL-3.0-only
//
// The promotion suite's artefact store (S0-1 promotion same artefact): builds
// named as the staging definition names them, each carrying its stamp and the
// digest of its bytes.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';
import { recordedStamp, stampOutput } from '../../scripts/ops/build-output.ts';
import { untrustedChain } from '../../scripts/ops/served-copy.ts';

const definition = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
) as { 'x-ops-astro': { artefact: string } };
/** The artefact name S0-1a's definition names, for one version. */
export const named = (version: string): string =>
  definition['x-ops-astro'].artefact.replace('{version}', version);

export const STAGED = '0123456789ab';
export const NEWER = 'fedcba987654';
export const LINE = 'Tried the task page and the approval queue on staging; both behave.';

/**
 * A new folder whose every folder up to `/` passes the promotion's trust walk
 * (OPS497TRUST), so a promotion may point a link inside it: the real temp
 * folder where it passes (macOS's, behind /var's link), else the home folder
 * (Linux's /tmp is sticky, so it is refused).
 */
export function trustedTemp(prefix: string): string {
  const uid = process.getuid?.();
  const bases = [realpathSync(tmpdir()), realpathSync(homedir())];
  const base = bases.find((at) => untrustedChain(at, uid) === undefined);
  if (base === undefined) throw new Error(`no folder a promotion trusts: ${bases.join(', ')}`);
  return mkdtempSync(join(base, prefix));
}

export const scratch: string = trustedTemp('s0-1d-');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let stores = 0;
/** An artefact store: one directory per build, each carrying its own stamp. */
export const store = (builds: Record<string, string | null>): string => {
  stores += 1;
  const root = join(scratch, `store${stores}`);
  for (const [name, stamp] of Object.entries(builds)) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'index.html'), `<meta name="ops-astro-build">`);
    if (stamp === null) continue;
    stampOutput(join(root, name), stamp);
  }
  return root;
};
export const STORE = (): string => store({ [named(STAGED)]: STAGED, [named(NEWER)]: NEWER });

/** One line as staging's web deploy records it: the version and the digest it handed Vercel. */
export const stagingLine = (version: string, digest: unknown): Record<string, unknown> => ({
  action: 'deploy recorded',
  environment: 'staging',
  version,
  artefact: named(version),
  digest,
  deployment: 'https://ops-astro-staging-a1b2c3d4e.vercel.app',
  region: 'syd1',
  runtime: 'nodejs24.x',
  authVersion: 'v2.180.0',
  business: 'made-up-business',
  operator: 'made-up-person',
  at: '2026-10-14T00:00:00.000Z',
});

let folders = 0;
/** An operator's record folder holding `lines` (objects as JSON, strings as given). */
export const records = (lines: readonly (string | object)[]): string => {
  folders += 1;
  const root = join(scratch, `records${folders}`);
  mkdirSync(root, { mode: 0o700 });
  const text = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line)));
  writeFileSync(join(root, 'deployments.jsonl'), text.map((line) => `${line}\n`).join(''), {
    mode: 0o600,
  });
  return root;
};

/** The record folder staging leaves after deploying every stamped build in `root`, as it is now. */
export const staged = (root: string): string =>
  records(
    readdirSync(root).flatMap((name) => {
      const { build, digest } = recordedStamp(join(root, name));
      return typeof build === 'string' ? [stagingLine(build, digest)] : [];
    }),
  );

/**
 * After staging recorded it, a store writer puts a self-consistent tree of
 * their own under `version`'s name in `root`: `files` (a whole build output,
 * if one is needed) with a page of theirs, stamped and digested afresh.
 */
export function replaced(
  root: string,
  files: Readonly<Record<string, string | object>> = {},
  version: string = STAGED,
): void {
  const out = join(root, named(version));
  rmSync(out, { recursive: true, force: true });
  const theirs = { ...files, 'static/index.html': '<meta name="not-what-staging-ran">' };
  for (const [path, body] of Object.entries(theirs)) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  stampOutput(out, version);
}

/** Checks every item with `check`; each makes what it needs of its own, so none waits on another. */
export const each = async <T>(
  items: readonly T[],
  check: (item: T) => Promise<void>,
): Promise<void> => {
  await Promise.all(items.map(async (item) => await check(item)));
};
