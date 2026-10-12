// SPDX-License-Identifier: AGPL-3.0-only
// Every Action pinned to a commit, and every pin written down.
//
// Finding 20 of the sweep of 6 September had two halves. The download half is
// fixed in the workflow itself: the gitleaks archive is verified against a
// published digest before anything is extracted. This is the other half.
//
// A full commit hash is sound syntax. It is not verification: a hash proves
// only that the bytes have not changed since somebody wrote the hash down,
// and says nothing about whether the right thing was written down. So the
// repository keeps a record of where each pin came from and how it was
// checked, and this script fails when a workflow and that record disagree.
//
// Three rules:
//   1. Every `uses:` in .github/workflows is pinned to a 40 character commit
//      hash. A tag can be moved; a hash cannot.
//   2. Every `image:` in .github/workflows is pinned to a sha256 digest. A
//      service container runs code in the job like any action does, and
//      `postgres:17-alpine` is a tag its publisher can move under us. This
//      rule arrived with the database conformance job, which was the first
//      service container in this repository; until then the check read only
//      `uses:` and a moved image tag would have passed it.
//      The security review of d77b375, finding 4, 24 September: the rule read
//      only `image:`, so a job's `container: node:20` passed, and it skipped
//      an image written as an expression. A `container:` naming its image
//      directly is held to the same digest, and an expression is refused: it
//      chooses the image at run time, so nothing in the workflow pins it. A
//      bare `container:` opens a mapping whose own `image:` line is read.
//      The rerun at 356dbe5 added `uses: docker://`, held to the same digest.
//   3. Every pin appears in docs/supply-chain-pins.md. A pin nobody recorded
//      is a pin nobody verified.
//   4. Every `*IMAGE=` line in scripts/local/*.sh is held to rules 2 and 3
//      (CQ-3). An image named inline on a `docker run` line is not read.
//
// Each workflow is parsed with the repository's YAML parser and every mapping
// key that resolves to `uses`, `image` or `container` is checked, wherever it
// sits. Quoting, escapes, tags, anchors, aliases, flow collections and
// explicit `? ` keys all resolve before the check reads the key, so none of
// them hides one (the line reader this replaced was bypassed by each in turn).
// A workflow that does not parse is refused.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '..');
const workflowDir = join(repoRoot, '.github', 'workflows');
const recordPath = join(repoRoot, 'docs', 'supply-chain-pins.md');

const PINNED = /^(?<action>[^@]+)@(?<sha>[0-9a-f]{40})$/u;
const DIGESTED = /^(?<image>[^@]+)@sha256:(?<digest>[0-9a-f]{64})$/u;

/** A value without its comment and its quotes. */
const clean = (v) =>
  v
    .replace(/(?:^|\s)#.*$/u, '')
    .trim()
    .replace(/^(['"])(.*)\1$/u, '$2');

const failures = [];
const pins = new Map();
const images = new Map();

if (!existsSync(workflowDir)) {
  console.error(`pins: no workflow directory at ${workflowDir}`);
  process.exit(2);
}

const workflows = readdirSync(workflowDir).filter((f) => /\.ya?ml$/u.test(f));
if (workflows.length === 0) {
  console.error('pins: no workflows found; this check would pass vacuously.');
  process.exit(2);
}

/** Every key in a parsed workflow, with its value and where it sits. */
function* entries(node, path, seen = new Set()) {
  if (node === null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  for (const [key, value] of Array.isArray(node) ? node.entries() : Object.entries(node)) {
    const at = Array.isArray(node) ? `${path}[${key}]` : `${path}.${key}`;
    if (!Array.isArray(node)) yield { key, value, at };
    yield* entries(value, at, seen);
  }
}

const checkImage = (where, ref) => {
  if (ref.includes('${{')) {
    failures.push(
      `${where}: the container image ${ref} is an expression.\n` +
        '        It chooses the image at run time, so no digest here pins it.\n' +
        '        Write the image itself: `image@sha256:<64 hex>`.',
    );
  } else if (DIGESTED.exec(ref)?.groups === undefined) {
    failures.push(
      `${where}: the container image ${ref} is not pinned to a sha256 digest.\n` +
        '        A service container runs code in the job. Pin it the way an\n' +
        '        action is pinned: `image@sha256:<64 hex>`, with the tag it\n' +
        '        came from in a comment beside it.',
    );
  } else images.set(ref, where);
};

const checkUses = (where, ref) => {
  if (ref.startsWith('./')) return;
  // The security rerun at 356dbe5, N2: a `docker://` step runs a container
  // like `image:` does, so it is held to the same digest and the same record.
  if (ref.startsWith('docker://')) {
    const image = ref.slice('docker://'.length);
    if (DIGESTED.exec(image)?.groups === undefined) {
      failures.push(
        `${where}: the step image ${ref} is not pinned to a sha256 digest.\n` +
          '        Pin it as `docker://image@sha256:<64 hex>` and record it.',
      );
    } else images.set(image, where);
  } else if (PINNED.exec(ref)?.groups === undefined) {
    failures.push(
      `${where}: ${ref} is not pinned to a 40 character commit hash.\n` +
        '        A tag can be moved by whoever owns it. A hash cannot.',
    );
  } else pins.set(ref, where);
};

for (const file of workflows) {
  const documents = parseAllDocuments(readFileSync(join(workflowDir, file), 'utf8'));
  const broken = documents.flatMap((d) => d.errors);
  if (broken.length > 0) {
    failures.push(
      `${file}: does not parse as YAML, so its pins cannot be read: ${broken[0]?.message}`,
    );
    continue;
  }
  for (const document of documents) {
    for (const { key, value, at } of entries(document.toJS(), file)) {
      if (key !== 'uses' && key !== 'image' && key !== 'container') continue;
      // A `container:` mapping is checked through its own `image` key.
      if (key === 'container' && value !== null && typeof value === 'object') continue;
      if (typeof value !== 'string' || value.trim() === '') {
        failures.push(`${at}: \`${key}:\` names no action or image.`);
        continue;
      }
      if (key === 'uses') checkUses(at, value.trim());
      else checkImage(at, value.trim());
    }
  }
}

const localDir = join(repoRoot, 'scripts', 'local');
const IMAGE_LINE = /^\s*(?:export\s+)?(?<name>\w*IMAGE)=(?<value>.*)$/u;
const workflowImages = images.size;
let localImages = 0;
const scripts = existsSync(localDir) ? readdirSync(localDir).filter((f) => f.endsWith('.sh')) : [];
for (const file of scripts) {
  // An unreadable script throws here and the check exits non-zero: never zero images.
  const lines = readFileSync(join(localDir, file), 'utf8').split(/\r\n|\r|\n/u);
  for (const [i, line] of lines.entries()) {
    const match = IMAGE_LINE.exec(line);
    if (match?.groups === undefined) continue;
    const ref = clean(match.groups['value'] ?? '');
    const where = `scripts/local/${file}:${i + 1}`;
    if (DIGESTED.exec(ref)?.groups === undefined) {
      failures.push(
        `${where}: ${match.groups['name']}=${ref} is not pinned to a sha256 digest.\n` +
          '        A tag can be moved by whoever owns it. Write `image:tag@sha256:<64 hex>`.',
      );
      continue;
    }
    images.set(ref, `scripts/local/${file}`);
    localImages += 1;
  }
}

console.log(
  `pins: ${pins.size} pinned action reference(s) and ${workflowImages} pinned image(s) ` +
    `across ${workflows.length} workflow(s), and ${localImages} in local scripts`,
);

if (!existsSync(recordPath)) {
  failures.push(
    'docs/supply-chain-pins.md does not exist.\n' +
      '        Every pin needs a record of where it came from and how it was\n' +
      '        checked. A pin nobody recorded is a pin nobody verified.',
  );
} else {
  const record = readFileSync(recordPath, 'utf8');
  for (const [ref, where] of pins) {
    const sha = ref.split('@')[1] ?? '';
    if (!record.includes(sha)) {
      failures.push(
        `${where}: ${ref} is not in docs/supply-chain-pins.md.\n` +
          '        Record the tag it corresponds to and how that was checked.',
      );
    }
  }
  for (const [ref, where] of images) {
    const digest = ref.split('@sha256:')[1] ?? '';
    if (!record.includes(digest)) {
      failures.push(
        `${where}: the image ${ref} is not in docs/supply-chain-pins.md.\n` +
          '        Record the tag it corresponds to and how that was checked.',
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`\npins: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

console.log('pins: every action and image is pinned to a hash, and every pin is recorded.');
