// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const extensions = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.py',
  '.sh',
  '.sql',
]);

export function ownedSources(root) {
  return [
    ...new Set(
      execFileSync(
        'git',
        ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { encoding: 'utf8' },
      )
        .split('\0')
        .filter(Boolean),
    ),
  ]
    .filter((path) => !path.startsWith('.claude/skills/') && !path.startsWith('.codex/skills/'))
    .filter(
      (path) =>
        extensions.has(extname(path)) || (path.startsWith('.husky/') && extname(path) === ''),
    )
    .filter((path) => existsSync(resolve(root, path)))
    .toSorted();
}

export function headerErrors(root) {
  return ownedSources(root).filter((path) => {
    const markers = readFileSync(resolve(root, path), 'utf8')
      .split(/\r?\n/u)
      .slice(0, 6)
      .filter((line) => /^(?:\/\/|#|--)\s*SPDX-License-Identifier:/u.test(line));
    return (
      markers.length !== 1 ||
      !/^(?:\/\/|#|--) SPDX-License-Identifier: AGPL-3\.0-only$/u.test(markers[0])
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..'));
    if (process.argv.length > 3) throw new Error('usage: spdx-check.mjs [working-repository]');
    const failures = headerErrors(root);
    for (const path of failures) console.error(`spdx: ${path} needs one correct source header`);
    console.log(
      `spdx: ${ownedSources(root).length} owned source files, ${failures.length} invalid headers`,
    );
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch {
    console.error('spdx: source discovery or header read failed');
    process.exitCode = 2;
  }
}
