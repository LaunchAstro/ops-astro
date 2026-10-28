// SPDX-License-Identifier: AGPL-3.0-only
//
// The deployment record (`recordDeployment`, operator.ts, writes it) and the
// one fact production reads back from it (#970): the digest staging's web
// deploy handed Vercel for a version (web-deploy.ts, `deploy recorded` with
// `environment: 'staging'` and a `digest`). The artefact store is shared, so
// a store writer can put a self-consistent tree under a version's name; the
// record is what ties the bytes production selects to the ones staging ran.
//
// The record is believed only inside the promotion's trust boundary
// (OPS497TRUST, served-copy.ts): every folder from the record folder up to `/`
// passes `untrustedChain`, and the file, opened once without following a
// link, is a regular file owned by root or the running user with no group or
// other write, checked on the open file itself. A line that is not a record,
// or a digest of the wrong shape, refuses rather than being read past. Lines
// of other environments, versions or acts never count, nor do staging's M5
// deploys, which record no digest because the M5's unit runs no artefact
// bytes. Staging lines for the version that disagree refuse: staging then
// ran more than one tree under one build.
//
// With staging off by the owner's decision (#2285), production reads the
// release step's line in its place (`release recorded`, release.ts): the
// version and the digest of the output it wrote, judged by the same rules, so
// a version released twice with different bytes refuses as well.

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { untrustedChain } from './served-copy.ts';

/** The file in the record folder, one JSON line per act. */
export const RECORD_FILE = 'deployments.jsonl';

/** Whose lines a read counts: staging's web deploys, or the release step's (#2285). */
export type RecordSource = 'staging' | 'release';

/** The record a refusal names. */
export const recordName = (source: RecordSource): string =>
  source === 'staging' ? "staging's record" : 'the release record';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** The record file's text, read once from a file only root or the running user writes, or why not. */
function trustedText(file: string, uid: number | undefined): string | { why: string } {
  let descriptor: number;
  try {
    // Non-blocking, so a pipe planted under the name never holds the step open.
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { why: `${file} is missing` };
    if (code === 'ELOOP') return { why: `${file} is a link; name the real path` };
    return { why: `${file} cannot be read: ${code ?? 'unknown error'}` };
  }
  try {
    const entry = fstatSync(descriptor);
    if (!entry.isFile()) return { why: `${file} is not a regular file` };
    if (entry.uid !== 0 && entry.uid !== uid)
      return { why: `${file} belongs to a user other than root and the promoter` };
    if ((entry.mode & 0o022) !== 0) return { why: `${file} can be written by others` };
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

/** The digests `source`'s lines for `version` in `text` record, or why the text is refused. */
function countedDigests(
  text: string,
  file: string,
  version: string,
  source: RecordSource,
): Set<string> | { why: string } {
  const digests = new Set<string>();
  const lines = text.split('\n');
  for (const [at, line] of lines.entries()) {
    // The newline that ends the last record.
    if (line === '' && at === lines.length - 1) continue;
    const where = `${file} line ${String(at + 1)}`;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = undefined;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { why: `${where} is not a record; nothing is read past it` };
    }
    const record = entry as Record<string, unknown>;
    const counted =
      (source === 'staging'
        ? record['action'] === 'deploy recorded' && record['environment'] === 'staging'
        : record['action'] === 'release recorded') &&
      record['version'] === version &&
      'digest' in record;
    if (!counted) continue;
    const digest = record['digest'];
    if (typeof digest !== 'string' || !DIGEST.test(digest)) {
      return { why: `${where} records a digest that is not sha256 and 64 hex digits` };
    }
    digests.add(digest);
  }
  return digests;
}

/**
 * The digest staging's web deploy (or, with `source` 'release', the release
 * step) recorded for `version` in the record folder `records`, or why there is
 * none to trust. Read whole each time it is asked, so a caller that waited
 * asks again (#970).
 */
export function stagedDigest(
  records: string,
  version: string,
  source: RecordSource = 'staging',
): { digest: string } | { why: string } {
  if (records === '') {
    return {
      why: "staging's record folder is not named: set OPS_ASTRO_DEPLOYMENTS to the folder staging's web deploy records in",
    };
  }
  const folder = resolve(records);
  const uid = process.getuid?.();
  const untrusted = untrustedChain(folder, uid);
  const name = recordName(source);
  if (untrusted !== undefined) return { why: `${name} folder: ${untrusted}` };
  const file = join(folder, RECORD_FILE);
  const text = trustedText(file, uid);
  if (typeof text !== 'string') return { why: `${name}: ${text.why}` };
  const digests = countedDigests(text, file, version, source);
  if ('why' in digests) return digests;
  const [only, ...others] = digests;
  const staging = source === 'staging';
  if (only === undefined) {
    return {
      why: staging
        ? `staging has no record of deploying ${version} in ${file}; production gets only the bytes a staging web deploy handed Vercel`
        : `the release step has no record of ${version} in ${file}; with staging off, production gets only the bytes a release recorded there`,
    };
  }
  if (others.length > 0) {
    const ran = staging ? 'staging ran' : 'the release step wrote';
    return {
      why: `${staging ? "staging's" : 'the release'} records of ${version} in ${file} disagree on its digest: ${ran} more than one tree under that build, so neither is promoted`,
    };
  }
  return { digest: only };
}

/**
 * Why `source`'s record no longer holds `digest` for `version`, or undefined
 * while it does: the record read and judged again in full after a wait (#970).
 */
export function notStillStaged(
  records: string,
  version: string,
  digest: string,
  source: RecordSource = 'staging',
): string | undefined {
  const staged = stagedDigest(records, version, source);
  if ('why' in staged) return staged.why;
  return staged.digest === digest
    ? undefined
    : `${recordName(source)} of ${version} now holds ${staged.digest}, not ${digest}`;
}
