// SPDX-License-Identifier: AGPL-3.0-only
//
// I1 (docs/plan/sandbox-contract.md, section 3): a `site.build` request is
// strict JSON with exactly `site`, `baseRevision`, `path` and `content`. The
// site must have a record (else `unknown site`) and a pin with an image id
// (else `no pin`, I4). `baseRevision` is 40 lowercase hex. The path is plain
// segments in I3's character set under one of the record's content
// directories, its last segment a name ending in one of the record's
// extensions; the content is a string of at most 64 KiB of UTF-8. Whether
// the path is a regular file at `baseRevision` is judged from the tree (I2).

import type { SiteEntry } from './pin-list.ts';
import type { Refused, SandboxResult, Why } from './refusal.ts';
import type { SiteRecord } from './site-record.ts';
import { SEGMENT } from './input-tree.ts';
import { hasExactKeys, isJsonObject, parseStrictJson } from './strict-json.ts';

export type BuildRequest = {
  readonly site: string;
  readonly baseRevision: string;
  readonly path: string;
  readonly content: Uint8Array;
};
/** The record and pin entry of a site id, or null when the site has no record. */
export type SiteOf = (id: string) => { record: SiteRecord; entry: SiteEntry } | null;

const KEYS = ['site', 'baseRevision', 'path', 'content'];
const REVISION = /^[0-9a-f]{40}$/u;
const MAX_CONTENT = 64 * 1024;

const refusal = (why: Why): Refused => ({ ok: false, reason: 'input refused', why });

function pathFits(path: string, record: SiteRecord): boolean {
  const segments = path.split('/');
  const name = segments.at(-1) ?? '';
  return (
    record.contentDirectories.some((directory) => path.startsWith(directory)) &&
    segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..') &&
    record.contentExtensions.some(
      (extension) => name.endsWith(extension) && name.length > extension.length,
    )
  );
}

export function readBuildRequest(
  bytes: Uint8Array,
  siteOf: SiteOf,
): SandboxResult<{ request: BuildRequest; record: SiteRecord; entry: SiteEntry }> {
  const read = parseStrictJson(bytes);
  if (!read.ok) return refusal(read.why);
  const value = read.value;
  if (!hasExactKeys(value, KEYS) || !isJsonObject(value)) return refusal('request key');
  const { site, baseRevision, path, content } = value;
  if (typeof site !== 'string' || typeof baseRevision !== 'string' || !REVISION.test(baseRevision))
    return refusal('request value');
  const known = siteOf(site);
  if (known === null) return { ok: false, reason: 'unknown site', why: 'site id' };
  if (known.entry.image === '') return { ok: false, reason: 'no pin', why: 'pin image' };
  if (typeof path !== 'string' || !pathFits(path, known.record)) return refusal('request path');
  const encoded = typeof content === 'string' ? new TextEncoder().encode(content) : null;
  if (encoded === null || encoded.length > MAX_CONTENT) return refusal('request content');
  return {
    ok: true,
    request: { site, baseRevision, path, content: encoded },
    record: known.record,
    entry: known.entry,
  };
}
