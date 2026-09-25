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

// Contributor addresses, scoped by where the address sits.
//
// The naive rule is "no address anywhere", and it is the case this scope
// exists to avoid: every commit in this repository is authored by a GitHub
// no-reply identity, so a blanket rule fails the whole port range on its own
// provenance and teaches everyone to pass `--no-verify`. The distinction is
// real. An enumerated identity in a commit's author, committer or trailers is
// provenance Git put there. The same string inside a file or a path is
// published contact detail, which is what this policy is about.
// The final label must be alphabetic. Without that, an npm specifier such as
// a scoped package at a three-part version reads as an address and every
// lockfile in the repository becomes a finding.
const addressPattern = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/giu;

// Provenance only. Allowed as a commit identity; a finding inside a blob.
const provenanceIdentities = [
  /^(?:\d+\+)?[a-z0-9-]+@users\.noreply\.github\.com$/u,
  /^noreply@github\.com$/u,
];

// Deliberately published, so allowed wherever they appear: the public
// security address this project documents, and the reserved documentation
// domains of RFC 2606 and RFC 6761, which can never reach a mailbox.
const publishedAddresses = [
  /^security@launchastro\.com$/u,
  /^[a-z0-9._%+-]+@example\.(?:invalid|test|localhost)$/u,
  /^[a-z0-9._%+-]+@example\.(?:com|net|org)$/u,
];

// A raw commit object, as `git cat-file commit` prints it, is indexed under
// this synthetic path by publicHistory.
//
// Round nine, 23 September, found the comment that used to sit here wrong. It
// said nothing in a working tree can take that shape, and a tracked file
// named `commit-<40 hex>-metadata` takes it exactly: the filename alone
// bought the commit-provenance exemption, and a contributor address inside
// that blob passed both the staged scan and the history scan. A filename is
// not provenance. The scope now travels with the entry that publicHistory
// built from a real commit object, and the shape is checked as well, so a
// tracked path can no longer claim it however it is named.
const commitMetadataPath = /^commit-[0-9a-f]{40}-metadata$/u;

// A set, not one digest, and for the same reason the gate's exemption file
// keeps one: a history scan reads every version of the fixture the outgoing
// commits reach, not only the one checked out now.
const approvedShapeDigests = new Set([
  '991dcbfd7983836cd4b8070bc4db18e8aa2d41414a4db61c1dc53e9253e78b18',
  'b6b9ae5cdad61b3087e053e27f87fddb94f0ad205310a55544eca9a6517e5299',
]);

export function addressRules(text, scope) {
  const found = new Set();
  for (const [address] of text.matchAll(addressPattern)) {
    const value = address.toLowerCase();
    if (publishedAddresses.some((allowed) => allowed.test(value))) continue;
    if (scope === 'commit') {
      if (provenanceIdentities.some((allowed) => allowed.test(value))) continue;
      found.add('unlisted-commit-identity');
      continue;
    }
    found.add('contributor-address');
  }
  return [...found];
}

// A raw commit object is headers, a blank line, then the message. Only the
// author and committer headers and the trailer block that closes the message
// are provenance. The subject, the body and every other header are published
// text, so a no-reply address written into a message body is a finding. A
// closing paragraph counts as trailers only when every line is `Key: value`;
// anything else leaves it in the body, which fails closed.
export function commitAddressRules(raw) {
  const split = raw.indexOf('\n\n');
  const headers = (split === -1 ? raw : raw.slice(0, split)).split('\n');
  const message = split === -1 ? '' : raw.slice(split + 2);
  const paragraphs = message.replace(/\n+$/u, '').split(/\n{2,}/u);
  const closing = paragraphs.length > 1 ? paragraphs.at(-1) : '';
  const trailers =
    closing !== '' && closing.split('\n').every((line) => /^[A-Za-z0-9-]+: \S/u.test(line));
  const identity = /^(?:author|committer) /u;
  const provenance = [
    ...headers.filter((line) => identity.test(line)),
    ...(trailers ? [closing] : []),
  ].join('\n');
  const published = [
    ...headers.filter((line) => !identity.test(line)),
    ...(trailers ? paragraphs.slice(0, -1) : paragraphs),
  ].join('\n');
  return [
    ...new Set([...addressRules(provenance, 'commit'), ...addressRules(published, 'content')]),
  ];
}

export function contentRules(text, scope = 'content') {
  const found = rules.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
  found.push(...(scope === 'commit' ? commitAddressRules(text) : addressRules(text, scope)));
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
  for (const { path, bytes, scope: declared } of entries) {
    // Only publicHistory declares this, and only for the raw commit object it
    // read itself. Everything else -- the index, a candidate directory, every
    // blob in the history's trees -- is ordinary content.
    const scope = declared === 'commit' && commitMetadataPath.test(path) ? 'commit' : 'content';
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
      approvedShapeDigests.has(createHash('sha256').update(bytes).digest('hex'));
    for (const rule of contentRules(text, scope)) {
      if ((rule === 'personal-path' || rule === 'contributor-address') && approvedShapes) continue;
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
    files.push({
      path: `commit-${sha}-metadata`,
      bytes: git(['cat-file', 'commit', sha]),
      scope: 'commit',
    });
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
