// SPDX-License-Identifier: AGPL-3.0-only
//
// I2 (docs/plan/sandbox-contract.md, section 3): the launcher assembles the
// input tree itself, in memory, from the site repository's git objects at
// `baseRevision`, read one raw object at a time through the credential
// broker. Every object's bytes must hash to its git object id (the commit,
// each tree, each blob), so a listing the broker cut short or changed is
// refused, never trusted. A commit must open with its tree line; a tree
// object is git's own `<mode> <name>\0<20-byte id>` entries, and one that
// ends inside an entry is a refusal. The trees are read first, counting
// entries against I3's cap and refusing a symlink, submodule or any other
// mode before anything under it is read; the blobs follow, each read with
// what is left of I3's 50 MB. A name is UTF-8 of at most 255 bytes with no
// slash, a path at most 4,096 bytes. The changed file must replace a
// regular file at `baseRevision`, and the edited tree is judged by I3.
// A broker failure is thrown to the caller.

import { createHash } from 'node:crypto';
import { checkTree, MAX_BYTES, MAX_ENTRIES, type TreeEntry } from './input-tree.ts';
import type { Refused, SandboxResult, Why } from './refusal.ts';

/** The broker's read: the raw bytes of one git object, at most `maxBytes` of them. */
export type GitRead = (oid: string, maxBytes: number) => Promise<Uint8Array>;

/** A commit or tree object; 20,000 entries of at most 283 bytes fit. */
const OBJECT_CAP = 6_000_000;
const MAX_NAME = 255;
const MAX_PATH = 4096;
const OID_BYTES = 20;
const REVISION = /^[0-9a-f]{40}$/u;
/** Git's raw modes for a regular file, an executable and a directory, spelt as I3 reads them. */
const MODES: ReadonlyMap<string, string> = new Map([
  ['100644', '100644'],
  ['100755', '100755'],
  ['40000', '040000'],
]);
const DIRECTORY = '040000';
const utf8 = new TextDecoder('utf-8', { fatal: true });

type Blob = { readonly path: string; readonly mode: string; readonly oid: string };
type Walk = { readonly directories: TreeEntry[]; readonly blobs: Blob[] };

const refusal = (why: Why): Refused => ({ ok: false, reason: 'input refused', why });

/** The object's bytes when they hash to `oid` as a `type` object, else the clause refused. */
async function readObject(
  read: GitRead,
  oid: string,
  type: 'commit' | 'tree' | 'blob',
  maxBytes: number,
): Promise<Uint8Array | Why> {
  const bytes = await read(oid, maxBytes);
  if (bytes.length > maxBytes) return 'tree size';
  const id = createHash('sha1')
    .update(`${type} ${String(bytes.length)}\0`)
    .update(bytes);
  return id.digest('hex') === oid ? bytes : 'tree object';
}

/** The tree id a raw commit opens with, or null when it does not open with one. */
function commitTree(commit: Uint8Array): string | null {
  const head = Buffer.from(commit.subarray(0, 46)).toString('latin1');
  const oid = head.slice(5, 45);
  return head.startsWith('tree ') && head.endsWith('\n') && REVISION.test(oid) ? oid : null;
}

/** One tree object's entries into `walk`; the subtrees to read next, or the clause refused. */
function listTree(raw: Uint8Array, prefix: string, walk: Walk): Blob[] | Why {
  const subtrees: Blob[] = [];
  for (let at = 0; at < raw.length;) {
    const space = raw.indexOf(0x20, at);
    const nul = space < 0 ? -1 : raw.indexOf(0, space);
    if (nul < 0 || nul + 1 + OID_BYTES > raw.length) return 'tree listing';
    const mode = MODES.get(Buffer.from(raw.subarray(at, space)).toString('latin1'));
    if (mode === undefined) return 'tree type';
    let name: string;
    try {
      name = utf8.decode(raw.subarray(space + 1, nul));
    } catch {
      return 'tree name';
    }
    const path = `${prefix}${name}`;
    if (name === '' || name.includes('/') || nul - space - 1 > MAX_NAME) return 'tree name';
    if (Buffer.byteLength(path) > MAX_PATH) return 'tree name';
    if (walk.directories.length + walk.blobs.length + subtrees.length >= MAX_ENTRIES)
      return 'tree entries';
    const oid = Buffer.from(raw.subarray(nul + 1, nul + 1 + OID_BYTES)).toString('hex');
    if (mode === DIRECTORY) subtrees.push({ path, mode, oid });
    else walk.blobs.push({ path, mode, oid });
    at = nul + 1 + OID_BYTES;
  }
  return subtrees;
}

/** Every tree under `root`, listed before any blob is read. */
async function walkTrees(read: GitRead, root: string): Promise<Walk | Why> {
  const walk: Walk = { directories: [], blobs: [] };
  const pending: Blob[] = [{ path: '', mode: DIRECTORY, oid: root }];
  for (let tree = pending.shift(); tree !== undefined; tree = pending.shift()) {
    // eslint-disable-next-line no-await-in-loop -- one object at a time: each listing names the next reads, and the caps stop them in order
    const raw = await readObject(read, tree.oid, 'tree', OBJECT_CAP);
    if (typeof raw === 'string') return raw;
    const listed = listTree(raw, tree.path === '' ? '' : `${tree.path}/`, walk);
    if (typeof listed === 'string') return listed;
    for (const subtree of listed)
      walk.directories.push({ path: subtree.path, mode: DIRECTORY, size: 0 });
    pending.push(...listed);
  }
  return walk;
}

export async function assembleTree(
  read: GitRead,
  baseRevision: string,
  edit: { readonly path: string; readonly content: Uint8Array },
): Promise<
  SandboxResult<{ files: ReadonlyMap<string, Uint8Array>; entries: readonly TreeEntry[] }>
> {
  if (!REVISION.test(baseRevision)) return refusal('request value');
  const commit = await readObject(read, baseRevision, 'commit', OBJECT_CAP);
  if (typeof commit === 'string') return refusal(commit);
  const root = commitTree(commit);
  if (root === null) return refusal('tree listing');
  const walk = await walkTrees(read, root);
  if (typeof walk === 'string') return refusal(walk);
  const files = new Map<string, Uint8Array>();
  const entries: TreeEntry[] = [...walk.directories];
  let left = MAX_BYTES;
  for (const blob of walk.blobs) {
    // eslint-disable-next-line no-await-in-loop -- one blob at a time, each read with what is left of the cap
    const bytes = await readObject(read, blob.oid, 'blob', left);
    if (typeof bytes === 'string') return refusal(bytes);
    left -= bytes.length;
    const replaced = blob.path === edit.path ? edit.content : bytes;
    files.set(blob.path, replaced);
    entries.push({ path: blob.path, mode: blob.mode, size: replaced.length });
  }
  if (!walk.blobs.some((blob) => blob.path === edit.path)) return refusal('request path');
  const tree = checkTree(entries);
  return tree.ok ? { ok: true, files, entries } : tree;
}
