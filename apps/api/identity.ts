// SPDX-License-Identifier: AGPL-3.0-only
//
// The served identity (T2b, product issue 11, spike RN-03): which code a
// served proof actually ran against.
//
// The API reads its identity once, at process start, and serves that record
// for as long as it runs: an API started from a dirty tree keeps saying so
// after the tree is cleaned, because the code it loaded is the dirty code. The
// web dev server reads it on every request, because Vite serves edits without
// a restart. The migration head is read from the ledger on every request.
// Dirty means tracked files only; scratch folders are ignored by git and never
// count.
//
// The route names the checkout path and the process id, so it answers on
// loopback only (`T2 identity local`).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export interface ServedIdentity {
  readonly commit: string;
  readonly tree: string;
  readonly dirty: readonly string[];
  readonly pid: number;
  readonly checkout: string;
}

/** What one served proof records, read directly and through the web origin. */
export interface IdentityEvidence {
  readonly api: ServedIdentity & { readonly migrationHead: string };
  readonly apiViaWeb: ServedIdentity & { readonly migrationHead: string };
  readonly web: ServedIdentity;
  /** The tree of the commit the evidence is for. */
  readonly evidenceTree: string;
  /** `migrationHead` over the migration files at that commit. */
  readonly migrationFiles: string;
}

const git = (checkout: string, ...args: string[]): string =>
  execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();

export function readIdentity(checkout: string): ServedIdentity {
  const status = git(checkout, 'status', '--porcelain', '--untracked-files=no');
  return {
    commit: git(checkout, 'rev-parse', 'HEAD'),
    tree: git(checkout, 'rev-parse', 'HEAD^{tree}'),
    dirty: status === '' ? [] : status.split('\n').map((line) => line.slice(3)),
    pid: process.pid,
    checkout,
  };
}

/** A digest over the ordered `(version, checksum)` pairs, as the ledger or the files hold them. */
export function migrationHead(
  pairs: readonly { readonly version: string; readonly checksum: string }[],
): string {
  const ordered = pairs.toSorted((a, b) => (a.version < b.version ? -1 : 1));
  const text = ordered.map(({ version, checksum }) => `${version} ${checksum}\n`).join('');
  return createHash('sha256').update(text).digest('hex');
}

export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Every reason the evidence does not show one clean tree served by one API. */
export function identityDefects(evidence: IdentityEvidence): readonly string[] {
  const { api, apiViaWeb, web, evidenceTree, migrationFiles } = evidence;
  const defects: string[] = [];
  if (api.tree !== evidenceTree) defects.push(`API tree ${api.tree} is not ${evidenceTree}`);
  if (web.tree !== evidenceTree) defects.push(`web tree ${web.tree} is not ${evidenceTree}`);
  if (api.dirty.length > 0) defects.push(`API started dirty: ${api.dirty.join(', ')}`);
  if (web.dirty.length > 0) defects.push(`web serves uncommitted ${web.dirty.join(', ')}`);
  // The API as the web origin reaches it is the same process and the same
  // record, field by field: a pid alone would let a different tree through.
  for (const key of ['pid', 'commit', 'tree', 'checkout', 'migrationHead'] as const) {
    if (apiViaWeb[key] !== api[key]) {
      defects.push(
        `the web origin reaches an API process with ${key} ${apiViaWeb[key]}, not ${api[key]}`,
      );
    }
  }
  if (apiViaWeb.dirty.join('\n') !== api.dirty.join('\n')) {
    defects.push('the web origin reaches an API process with different dirty paths');
  }
  if (api.migrationHead !== migrationFiles) {
    defects.push(`migration head ${api.migrationHead} is not the files' ${migrationFiles}`);
  }
  return defects;
}
