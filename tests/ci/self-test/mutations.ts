// SPDX-License-Identifier: AGPL-3.0-only
//
// T4e's mutations (split section 3.2, row T4e; T4-N1 to T4-N4), each applied
// on a scratch branch in a disposable worktree of this repository and checked
// by the check that claims to catch it.
//
// A worktree, not `tests/support/source-mutant.ts`: that copies five package
// trees and neither `apps/` nor `migrations/`, which is right for one line in
// a package and wrong for removing a whole part or a migration. The worktree
// sits under the ignored `.local/self-test/`, on a branch of its own, and
// `close` removes both. It never commits to a branch anyone else reads.
//
// A mutation proves something only when it changed the tree and the check
// then ran: `classify` fails a mutation that applied nothing, a run in which
// nothing executed, and a check that stayed green.

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkMockupTree } from '../../visual/packet.ts';

const ROOT = resolve(import.meta.dirname, '../../..');

/** One part before T4e: its invariants, the files that carry them and its commits on this line. */
export interface Part {
  readonly id: string;
  readonly invariants: readonly string[];
  readonly files: readonly string[];
  /** What a revert leaves at the head: a path, or a folder ending in `/`. */
  readonly keep: readonly string[];
  readonly commits: readonly string[];
}

export const keeps = (part: Part, path: string): boolean =>
  part.keep.some((one) => (one.endsWith('/') ? path.startsWith(one) : path === one));

export const PARTS: readonly Part[] = (
  JSON.parse(readFileSync(join(import.meta.dirname, 'parts.json'), 'utf8')) as {
    parts: Part[];
  }
).parts;

/** What one mutation did and what its check said. */
export interface Ran {
  readonly applied: boolean;
  /** Cases, files or commands that reported an outcome; 0 means nothing ran. */
  readonly executed: number;
  readonly red: boolean;
  readonly detail: string;
}

export interface CaseLine {
  readonly case: string;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}

export function classify(name: string, ran: Ran): CaseLine {
  const fail = (why: string): CaseLine => ({
    case: name,
    status: 'fail',
    detail: `${why} (${ran.detail})`,
  });
  if (!ran.applied) return fail('the mutation changed nothing, so it proves nothing');
  if (ran.executed === 0) return fail('nothing ran under the mutation');
  if (!ran.red) return fail('stayed green under its mutation');
  return { case: name, status: 'pass', detail: `red under its mutation: ${ran.detail}` };
}

/** The unmutated control: the same check must be green, with something run, before a red means anything. */
export function control(name: string, ran: Ran): CaseLine {
  const green = ran.executed > 0 && !ran.red;
  return {
    case: name,
    status: green ? 'pass' : 'fail',
    detail: green ? `green unmutated: ${ran.detail}` : `not green unmutated: ${ran.detail}`,
  };
}

export function everyInvariantBites(lines: readonly CaseLine[]): CaseLine {
  const short = lines.filter((line) => line.status !== 'pass');
  const status = lines.length > 0 && short.length === 0 ? 'pass' : 'fail';
  const whole = lines.filter((line) => line.detail.includes('fails whole')).length;
  let detail =
    `${String(lines.length)} checks, each green unmutated and red under its own mutation ` +
    `(${String(whole)} of them because a file no longer loads or a hook fails without the part)`;
  if (lines.length === 0) detail = 'no mutation ran';
  else if (short.length > 0) detail = `not proven: ${short.map((line) => line.case).join('; ')}`;
  return { case: 'every_invariant_bites', status, detail };
}

/**
 * Whether `databaseUrl` is this machine's port that `docker port <cluster>
 * 5432/tcp` printed: the mutations' databases go on the command's own
 * container and nowhere else, not a remote host on the same port.
 */
export function onOwnCluster(databaseUrl: string, published: string): boolean {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return false;
  }
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '') return false;
  const bound = /^(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):(\d+)$/u;
  return published.split('\n').some((line) => bound.exec(line.trim())?.[1] === url.port);
}

export interface Scratch {
  readonly dir: string;
  readonly branch: string;
  /** The head the mutations start from. */
  readonly base: string;
  git(args: readonly string[]): string;
  /** Back to `base`, nothing untracked left; ignored files (the install) stay. */
  reset(): void;
  commit(message: string): string;
  close(): void;
}

const gitIn = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function openScratch(): Scratch {
  const id = randomUUID().slice(0, 8);
  const dir = join(ROOT, '.local', 'self-test', id);
  const branch = `scratch/t4e-${id}`;
  const git = (args: readonly string[], cwd = dir): string => gitIn(cwd, args);
  const base = git(['rev-parse', 'HEAD'], ROOT).trim();
  mkdirSync(join(ROOT, '.local', 'self-test'), { recursive: true });
  git(['worktree', 'add', '-q', '-b', branch, dir, base], ROOT);
  return {
    dir,
    branch,
    base,
    git,
    reset: () => {
      git(['reset', '-q', '--hard', base]);
      // -ff: a mutation's own git repository (the pinned mockup's) goes too.
      git(['clean', '-ffdq']);
    },
    commit: (message) => {
      git(['add', '-A']);
      // Local to the scratch branch, never pushed: unsigned, and no hooks.
      const who = ['-c', 'user.name=T4e self-test', '-c', 'user.email=self-test@invalid'];
      git([
        ...who,
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '--no-verify',
        '-m',
        message,
      ]);
      return git(['rev-parse', 'HEAD']).trim();
    },
    close: () => {
      spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT });
      rmSync(dir, { recursive: true, force: true });
      spawnSync('git', ['worktree', 'prune'], { cwd: ROOT });
      spawnSync('git', ['branch', '-D', branch], { cwd: ROOT });
    },
  };
}

/** Replaces text that occurs exactly once, as `source-mutant.ts` does; anything else applies nothing. */
export function edit(scratch: Scratch, file: string, from: string, to: string): boolean {
  const path = join(scratch.dir, file);
  const text = readFileSync(path, 'utf8');
  if (text.split(from).length !== 2) return false;
  writeFileSync(path, text.replace(from, to));
  return true;
}

/**
 * T4-N1. The newest migration, because no later one depends on it: the
 * migration runner applies what is left without complaint, so only the
 * migration check can catch it, and it must name the file.
 */
export function deleteOneMigration(scratch: Scratch): Ran {
  scratch.reset();
  const newest = readdirSync(join(scratch.dir, 'migrations'))
    .filter((file) => file.endsWith('.sql'))
    .toSorted()
    .at(-1);
  if (newest === undefined) return { applied: false, executed: 0, red: false, detail: 'none' };
  rmSync(join(scratch.dir, 'migrations', newest));
  const head = scratch.commit(`self-test: delete migrations/${newest}`);
  const check = spawnSync(process.execPath, ['scripts/migrations-unchanged.mjs'], {
    cwd: scratch.dir,
    env: { ...process.env, BASE_SHA: scratch.base, HEAD_SHA: head },
    encoding: 'utf8',
  });
  const named = `${check.stdout}${check.stderr}`.includes(`migrations/${newest}`);
  return {
    applied: true,
    executed: 1,
    red: check.status !== 0 && named,
    detail: `migrations:unchanged exit ${String(check.status)}, ${named ? 'naming' : 'not naming'} migrations/${newest}`,
  };
}

/**
 * T4-N3, the pinned mockup. A mockup repository of two commits, the second one
 * byte different: pinned to the first, the pin passes; pointed at the second
 * with the first's tree, `checkMockupTree` (T4c) refuses it.
 */
export function changePinnedMockup(scratch: Scratch): Ran {
  scratch.reset();
  const dir = join(scratch.dir, 'self-test-mockup');
  mkdirSync(dir);
  const git = (args: readonly string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const who = ['-c', 'user.name=T4e self-test', '-c', 'user.email=self-test@invalid'];
  const save = (text: string): { commit: string; tree: string } => {
    writeFileSync(join(dir, 'index.html'), text);
    git(['add', 'index.html']);
    git([...who, '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'mockup']);
    return { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']) };
  };
  git(['init', '-q']);
  const said: string[] = [];
  let pinned = { commit: '', tree: '' };
  let changed = { commit: '', tree: '' };
  try {
    pinned = save('<p>gate</p>\n');
    changed = save('<p>gatf</p>\n');
    for (const pin of [pinned, { commit: changed.commit, tree: pinned.tree }]) {
      try {
        checkMockupTree(dir, pin);
        said.push('passes');
      } catch (error) {
        said.push(String((error as Error).message));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const refused = said[1] ?? '';
  return {
    applied: changed.tree !== pinned.tree,
    executed: said.length,
    red: said[0] === 'passes' && /pinned mockup changed/u.test(refused),
    detail: `the pin ${String(said[0])}; one byte later: ${refused.replace('visual: ', '')}`,
  };
}

/**
 * T4-N4. Reverts every commit of the part, newest first, outside what the part
 * keeps. A commit whose reverse no longer applies, because later parts built
 * on it, has its files set back to before that commit, and the detail counts
 * them. The kept files are then put back as they are at the head.
 */
export function revertPart(scratch: Scratch, part: Part): { applied: boolean; detail: string } {
  scratch.reset();
  const kept = (path: string): boolean => keeps(part, path);
  const exclude = part.keep.map((one) => `--exclude=${one.endsWith('/') ? `${one}*` : one}`);
  let restored = 0;
  for (const commit of part.commits.toReversed()) {
    const patch = scratch.git(['show', '--binary', '--no-renames', '--format=', commit]);
    const reverse = spawnSync('git', ['apply', '-R', '--3way', '--index', ...exclude], {
      cwd: scratch.dir,
      input: patch,
      encoding: 'utf8',
    });
    if (reverse.status !== 0) {
      scratch.git(['reset', '-q', '--hard']);
      restored += 1;
      const paths = scratch.git(['show', '--no-renames', '--name-only', '--format=', commit]);
      for (const path of paths.split('\n').filter((one) => one !== '' && !kept(one))) {
        const before = spawnSync('git', ['cat-file', '-e', `${commit}^:${path}`], {
          cwd: scratch.dir,
        });
        if (before.status === 0) scratch.git(['checkout', `${commit}^`, '--', path]);
        else scratch.git(['rm', '-q', '--ignore-unmatch', '--', path]);
      }
    }
    scratch.commit(`self-test: revert ${commit.slice(0, 8)} (${part.id})`);
  }
  scratch.git(['checkout', scratch.base, '--', ...part.keep]);
  scratch.commit(`self-test: keep ${part.id}'s invariant files`);
  const changed = scratch
    .git(['diff', '--name-only', scratch.base, 'HEAD'])
    .split('\n')
    .filter(Boolean);
  const how = restored === 0 ? '' : `, ${String(restored)} set back file by file`;
  return {
    applied: changed.length > 0,
    detail: `${String(part.commits.length)} commits reverted${how}, ${String(changed.length)} files differ`,
  };
}
