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

/** A source's line comment and block opener in its own syntax: `#` for scripts and hooks. */
const SYNTAX = { '.sql': ['--', '/*'], '.py': ['#'], '.sh': ['#'], '': ['#'] };

/**
 * The line comments a source opens with in its first six lines, read as its
 * own syntax reads them: a block comment ends at its first close, and the
 * first code, a string included, ends them.
 */
function leadingComments(path, text) {
  const [line, block] = SYNTAX[extname(path)] ?? ['//', '/*'];
  const head = text.split(/\r?\n/u).slice(0, 6).join('\n');
  const comments = [];
  let at = 0;
  for (;;) {
    while (/\s/u.test(head[at] ?? '')) at += 1;
    if (head.startsWith(line, at) || (at === 0 && head.startsWith('#!'))) {
      const end = head.indexOf('\n', at);
      comments.push(head.slice(at, end < 0 ? head.length : end));
      at = end < 0 ? head.length : end;
    } else if (block !== undefined && head.startsWith(block, at) && head.includes('*/', at + 2)) {
      at = head.indexOf('*/', at + 2) + 2;
    } else return { line, comments };
  }
}

export function headerErrors(root) {
  return ownedSources(root).filter((path) => {
    const { line, comments } = leadingComments(path, readFileSync(resolve(root, path), 'utf8'));
    const markers = comments.filter((one) =>
      one.slice(line.length).trimStart().startsWith('SPDX-License-Identifier:'),
    );
    return markers.length !== 1 || markers[0] !== `${line} SPDX-License-Identifier: AGPL-3.0-only`;
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
