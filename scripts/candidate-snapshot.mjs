// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sort = (entries) =>
  entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const git = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' });

function safePath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    isAbsolute(path) ||
    [...path].some(
      (char) => char === '\\' || char.codePointAt(0) < 32 || char.codePointAt(0) === 127,
    ) ||
    path.split('/').some((part) => ['', '.', '..', '.git'].includes(part))
  ) {
    throw new Error('invalid candidate path');
  }
}

export function externalOutput(path, roots) {
  const absolute = resolve(path);
  const canonical = join(
    realpathSync(dirname(absolute)),
    absolute.slice(dirname(absolute).length + 1),
  );
  if (roots.some((root) => inside(root, canonical)) || existsSync(canonical)) {
    throw new Error('output must be a new file outside the subject directories');
  }
  return canonical;
}

function entry(root, path) {
  safePath(path);
  const full = join(root, path);
  const stat = lstatSync(full);
  if (!stat.isFile() && !stat.isSymbolicLink())
    throw new Error('candidate contains an unsupported entry');
  const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
  const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(full)) : readFileSync(full);
  if (stat.isSymbolicLink()) {
    const target = bytes.toString('utf8');
    if (
      isAbsolute(target) ||
      !inside(root, resolve(dirname(full), target)) ||
      !inside(root, realpathSync(full))
    ) {
      throw new Error('candidate link must resolve within the candidate');
    }
  }
  return { path, mode, sha256: hash(bytes), bytes };
}

export function candidateFiles(candidate) {
  const root = realpathSync(candidate);
  const entries = [];
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      const path = relative(root, full).split(sep).join('/');
      safePath(path);
      if (lstatSync(full).isDirectory()) walk(full);
      else entries.push(entry(root, path));
    }
  }
  walk(root);
  return sort(entries);
}

export function indexFiles(repository) {
  const repo = realpathSync(repository);
  if (realpathSync(git(repo, ['rev-parse', '--show-toplevel']).toString().trim()) !== repo) {
    throw new Error('repo must name the repository root');
  }
  if (git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).length > 0) {
    throw new Error(
      'unstaged untracked files exist; stage intended files or remove them from this work copy',
    );
  }
  const staged = git(repo, ['ls-files', '--stage', '-z'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const entries = staged.map((line) => {
    const split = line.indexOf('\t');
    const [mode, oid, stage] = line.slice(0, split).split(' ');
    const path = line.slice(split + 1);
    safePath(path);
    if (stage !== '0' || !['100644', '100755', '120000'].includes(mode)) {
      throw new Error('index contains a conflict or unsupported entry');
    }
    let parent = dirname(path);
    while (parent !== '.') {
      if (lstatSync(join(repo, parent)).isSymbolicLink())
        throw new Error('index path has a symlink ancestor');
      parent = dirname(parent);
    }
    const bytes = git(repo, ['cat-file', 'blob', oid]);
    const actual = entry(repo, path);
    if (actual.mode !== mode || !actual.bytes.equals(bytes)) {
      throw new Error('index and worktree differ; stage the exact intended files first');
    }
    return { path, mode, sha256: hash(bytes), bytes };
  });
  if (entries.length === 0) throw new Error('candidate index is empty');
  const ignored = spawnSync('git', ['-C', repo, 'check-ignore', '--no-index', '--stdin', '-z'], {
    input: entries.map(({ path }) => path).join('\0') + '\0',
  });
  if (ignored.status !== 1)
    throw new Error('index contains ignored paths or ignore validation failed');
  return sort(entries);
}

function manifestFor(entries) {
  const files = entries.map(({ path, mode, sha256 }) => ({ path, mode, sha256 }));
  return {
    schema: 1,
    kind: 'local-candidate-files',
    evidence:
      'File paths, modes and bytes only. No commit, signature, hosted check or publication approval is certified.',
    treeSha256: hash(JSON.stringify(files) + '\n'),
    files,
  };
}

export function checkCandidate(candidate, manifestPath) {
  const root = realpathSync(candidate);
  if (inside(root, realpathSync(manifestPath)))
    throw new Error('manifest must be outside the candidate');
  const expected = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entries = candidateFiles(root);
  const actual = manifestFor(entries);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('candidate file set, mode, bytes or manifest identity differs');
  }
  return entries;
}

export function exportCandidate(repository, candidate, manifestPath) {
  const repo = realpathSync(repository);
  const target = externalOutput(candidate, [repo]);
  const out = externalOutput(manifestPath, [repo, target]);
  const entries = indexFiles(repo);
  mkdirSync(target);
  for (const { path, mode, bytes } of entries) {
    const full = join(target, path);
    mkdirSync(dirname(full), { recursive: true });
    if (mode === '120000') symlinkSync(bytes.toString('utf8'), full);
    else {
      writeFileSync(full, bytes, { flag: 'wx' });
      chmodSync(full, mode === '100755' ? 0o755 : 0o644);
    }
  }
  const exported = candidateFiles(target);
  const manifest = manifestFor(exported);
  if (manifest.treeSha256 !== manifestFor(entries).treeSha256)
    throw new Error('export differs from the staged input');
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  checkCandidate(target, out);
  return manifest;
}

export function options(args, names) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/u, '');
    const value = args[i + 1];
    if (
      !args[i]?.startsWith('--') ||
      !names.includes(key) ||
      result[key] ||
      !value ||
      value.startsWith('--')
    ) {
      throw new Error('invalid or duplicate command arguments');
    }
    result[key] = value;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const opts = options(args, ['repo', 'candidate', 'manifest']);
    if (
      !opts.candidate ||
      !opts.manifest ||
      !['export', 'check'].includes(command) ||
      (command === 'export' ? !opts.repo : !!opts.repo)
    ) {
      throw new Error(
        'usage: candidate-snapshot.mjs export --repo DIR --candidate NEW_DIR --manifest EXTERNAL_JSON; or check --candidate DIR --manifest EXTERNAL_JSON',
      );
    }
    const manifest =
      command === 'export'
        ? exportCandidate(opts.repo, opts.candidate, opts.manifest)
        : manifestFor(checkCandidate(opts.candidate, opts.manifest));
    console.log(
      `candidate-snapshot: ${manifest.files.length} local files, sha256 ${manifest.treeSha256}`,
    );
  } catch (error) {
    // Filesystem errors can contain private absolute paths. Do not echo them.
    console.error(
      `candidate-snapshot: ${error.code || error.status !== undefined || error instanceof SyntaxError ? 'filesystem, Git or manifest validation failed' : error.message}`,
    );
    process.exitCode = 1;
  }
}
