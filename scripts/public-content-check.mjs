// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkCandidate, indexFiles, options } from './candidate-snapshot.mjs';

// This small public-foundation policy supplements the existing contamination
// and secret scanners. Hashes avoid publishing excluded names and identities.
const excludedTokenHashes = new Set([
  '51a638da30b84b53774abb2c4a6e12645daad279f51354016452d3719b1eeca7',
  '56fe43f748e258de06b4955e2b8978bbc1c28ff9ba53917387d6dca8fb920018',
  // Synthetic tokens exercise this rule without carrying real identities.
  '675b6b1683ab1f3597ab19f6d5a7cd0900452d8f205a0cb0471fa7abdd3eb98d',
  '0921cc4b2766b9acdc1751926c2c3b8ac06f0fd5c545974176e971196abfe4e4',
]);
const rules = [
  ['project-finance-context', /\b(?:project|launch|seed|client)[-\s]+funding\b/iu],
  ['private-pitch-url', /\bhttps?:\/\/(?:[a-z0-9-]+\.)*pitch(?:es)?\.[a-z0-9.-]+/iu],
  [
    'commercial-proposal',
    /\b(?:sponsor(?:ship)?|funding|private[-\s]+client|client[-\s]+commercial)[-\s]+(?:proposal|round|agreement|arrangement|money|commitment|pitch|funding)\b/iu,
  ],
  [
    'personal-path',
    /(?:\/(?:Users|home)\/[a-z0-9._-]+|[a-z]:\\Users\\[a-z0-9._-]+|~\/(?:Desktop|Documents|Vaults)\/)/iu,
  ],
];

export function contentRules(text) {
  const found = rules.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
  const words = text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  if (
    words.some((word) => excludedTokenHashes.has(createHash('sha256').update(word).digest('hex')))
  )
    found.push('excluded-token');
  return found;
}

export function scanPublicFiles(entries) {
  const findings = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const { path, bytes } of entries) {
    const pathRules = contentRules(path);
    // A prohibited value can be in the filename itself. Withhold that path.
    const display = pathRules.length ? '<withheld-path>' : path;
    for (const rule of pathRules) findings.push({ file: display, rule });
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      findings.push({ file: display, rule: 'non-text-foundation-file' });
      continue;
    }
    if (text.includes('\0')) {
      findings.push({ file: display, rule: 'non-text-foundation-file' });
      continue;
    }
    // The inherited synthetic shape fixture is approved by exact bytes. This
    // exception covers its path shapes only; every other rule still scans it.
    const approvedShapes =
      path === 'tests/gate/shape-canary.txt' &&
      createHash('sha256').update(bytes).digest('hex') ===
        '991dcbfd7983836cd4b8070bc4db18e8aa2d41414a4db61c1dc53e9253e78b18';
    for (const rule of contentRules(text)) {
      if (rule === 'personal-path' && approvedShapes) continue;
      findings.push({ file: display, rule });
    }
  }
  return findings;
}

export function publicHistory(repository, range) {
  const git = (args) =>
    execFileSync('git', ['--no-replace-objects', '-C', repository, ...args], {
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
    });
  if (git(['rev-parse', '--is-shallow-repository']).toString().trim() !== 'false') {
    throw new Error('history policy requires a complete Git checkout');
  }
  let selection;
  if (range === undefined) selection = ['--branches', '--not', '--remotes'];
  else {
    const parts = range.split('..');
    if (parts.length > 2 || parts.some((part) => !part || part.startsWith('-'))) {
      throw new Error('range must be one commit/ref or BASE..HEAD');
    }
    const commits = parts.map((part) => {
      const oid = git(['rev-parse', '--verify', '--end-of-options', `${part}^{object}`])
        .toString()
        .trim();
      if (git(['cat-file', '-t', oid]).toString().trim() !== 'commit') {
        throw new Error(
          'range endpoints must be commits; annotated tag publication is not supported',
        );
      }
      return oid;
    });
    selection = [commits.join('..')];
  }
  const commits = git(['rev-list', ...selection])
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);
  const files = [];
  const blobs = new Map();
  const seen = new Set();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const sha of commits) {
    // Read the raw commit object, including author, committer and message.
    // Reporting uses the object ID only, never metadata or matched values.
    files.push({ path: `commit-${sha}-metadata`, bytes: git(['cat-file', 'commit', sha]) });
    const tree = decoder.decode(git(['ls-tree', '-rz', '--full-tree', sha]));
    for (const line of tree.split('\0').filter(Boolean)) {
      const split = line.indexOf('\t');
      const [mode, type, oid] = line.slice(0, split).split(' ');
      const path = line.slice(split + 1);
      if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)) {
        throw new Error('history contains an unsupported entry');
      }
      const pair = `${oid}\0${path}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      if (!blobs.has(oid)) blobs.set(oid, git(['cat-file', 'blob', oid]));
      files.push({ path, bytes: blobs.get(oid) });
    }
  }
  return { files, commits: commits.length, blobPaths: seen.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const outgoingAt = args.indexOf('--outgoing');
    const outgoing = outgoingAt !== -1;
    if (outgoing) args.splice(outgoingAt, 1);
    const opts = options(args, ['repo', 'candidate', 'manifest', 'range']);
    if (
      (opts.range && outgoing) ||
      (opts.repo
        ? opts.candidate || opts.manifest
        : !opts.candidate || !opts.manifest || opts.range || outgoing)
    ) {
      throw new Error(
        'usage: public-content-check.mjs --repo DIR [--range REF_OR_BASE..HEAD | --outgoing]; or --candidate DIR --manifest EXTERNAL_JSON',
      );
    }
    const history = opts.range || outgoing ? publicHistory(opts.repo, opts.range) : undefined;
    const files = history
      ? history.files
      : opts.repo
        ? indexFiles(opts.repo)
        : checkCandidate(opts.candidate, opts.manifest);
    if (history)
      console.log(
        `public-content: ${history.commits} commit(s), ${history.blobPaths} distinct historical blob/path pair(s)`,
      );
    const findings = scanPublicFiles(files);
    for (const { file, rule } of findings) console.error(`public-content: ${file} [${rule}]`);
    console.log(
      `public-content: ${files.length} ${history ? 'history entries' : 'files'}, ${findings.length} policy finding(s). This is a bounded content check, not a security certification.`,
    );
    process.exitCode = findings.length ? 1 : 0;
  } catch (error) {
    console.error(
      `public-content: ${error.code || error.status !== undefined || error instanceof SyntaxError ? 'file, Git or manifest validation failed' : error.message}`,
    );
    process.exitCode = 1;
  }
}
