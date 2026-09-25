// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm secrets`: gitleaks over the files this repository can actually publish.
//
// The obvious command, `gitleaks dir .`, reads the whole directory, including
// the gitignored runtime scratch under `.local/` that `scripts/local/db-up.sh`
// writes a generated password into. The obvious fix, an allowlist entry for
// `^\.local/.*$` in `.gitleaks.toml`, is worse than the problem: gitignored is
// not never-tracked, so a force-added `.local/x` (`git add -f`) would be
// committed with the scanner told in advance to look away.
//
// So the file list is built from git instead of from the filesystem:
//
//   git ls-files                      everything git already tracks, including
//                                     anything force-added under .local/
//   git ls-files --others             every candidate that is not ignored, so
//     --exclude-standard              a new file is scanned before it is added
//
// The union is exactly the set that can reach a commit, and ignored runtime
// scratch is excluded by being absent rather than by being exempted.
//
// gitleaks has no way to take that list. `gitleaks dir` documents one path
// argument, and given more than one it silently ignores all of them and scans
// the working directory instead -- measured on 8.30.1: two file arguments, and
// the byte count is the whole tree. Scanning once per file is the same scanner
// started four hundred times. So the list is materialised as a directory: each
// listed file is hardlinked (copied when the link cannot cross a device) into
// a temporary tree at the same relative path, and gitleaks scans that. Same
// bytes, same relative paths, so the path allowlist in `.gitleaks.toml` keeps
// meaning what it says, and the tree is removed on the way out.
//
// It exits non-zero on a leak, on an empty file list, and when gitleaks is not
// installed. An empty list means the git commands returned nothing, which is a
// scanner that has stopped scanning; a silent pass there is how a gate dies.
//
// The pre-commit hook is unchanged and still runs `gitleaks protect --staged`
// directly: that reads blobs out of the index, so it has no directory to
// wander into and no list to build.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const fail = (message) => {
  console.error(`secrets: ${message}`);
  process.exit(1);
};

const git = (...args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    fail(`\`git ${args.join(' ')}\` failed: ${result.stderr?.trim() ?? result.error?.message}`);
  }
  return result.stdout;
};

const root = git('rev-parse', '--show-toplevel').trim();
const config = join(root, '.gitleaks.toml');
if (!existsSync(config)) fail(`${config} is missing; refusing to scan with the default config.`);

if (spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).status !== 0) {
  fail('gitleaks is not installed or not on PATH. Install it; a skipped scan is not a pass.');
}

const listed = (...args) =>
  git('-C', root, ...args, '-z')
    .split('\0')
    .filter((path) => path !== '');

const tracked = listed('ls-files');
const candidates = listed('ls-files', '--others', '--exclude-standard');

// A tracked path can be staged for deletion, and a symlink is a path, not
// content: gitleaks does not follow one without --follow-symlinks, and its
// target is scanned on its own account if it is in the list.
const files = [...new Set([...tracked, ...candidates])].toSorted().filter((path) => {
  const absolute = join(root, path);
  return existsSync(absolute) && lstatSync(absolute).isFile();
});

if (files.length === 0) {
  fail('the file list is empty. git listed nothing, so nothing would be scanned.');
}

const mirror = mkdtempSync(join(tmpdir(), 'ops-astro-secrets-'));
let status = 1;
try {
  for (const path of files) {
    const target = join(mirror, path);
    mkdirSync(dirname(target), { recursive: true });
    try {
      linkSync(join(root, path), target);
    } catch {
      copyFileSync(join(root, path), target);
    }
  }

  console.log(
    `secrets: ${files.length} files (${tracked.length} tracked, ${candidates.length} not ignored and not yet tracked).`,
  );

  const result = spawnSync(
    'gitleaks',
    ['dir', '--no-banner', '--redact', '--config', config, '.'],
    {
      cwd: mirror,
      stdio: 'inherit',
    },
  );
  if (result.error !== undefined) fail(`gitleaks could not be run: ${result.error.message}`);
  status = result.status ?? 1;
} finally {
  rmSync(mirror, { recursive: true, force: true });
}

if (status !== 0) fail(`gitleaks exited ${status}. A file that can be committed carries a secret.`);
