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
//      `postgres:18-alpine` is a tag its publisher can move under us. This
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

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const workflowDir = join(repoRoot, '.github', 'workflows');
const recordPath = join(repoRoot, 'docs', 'supply-chain-pins.md');

// YAML allows space before the colon and a quoted key. Sol's recheck of
// 356dbe5: `container : node:20` read as no key at all.
const USES = /^\s*-?\s*(['"]?)uses\1[ \t]*:[ \t]*([^\s#]+)/gmu;
const PINNED = /^(?<action>[^@]+)@(?<sha>[0-9a-f]{40})$/u;
const IMAGE = /^\s*-?\s*(['"]?)(?<key>image|container)\1[ \t]*:[ \t]*(?<value>.*)$/u;
const MAPPING_KEY = /^\s*(['"]?)[\w-]+\1[ \t]*:(?:\s|$)/u;
const DIGESTED = /^(?<image>[^@]+)@sha256:(?<digest>[0-9a-f]{64})$/u;

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

for (const file of workflows) {
  const text = readFileSync(join(workflowDir, file), 'utf8');
  for (const match of text.matchAll(USES)) {
    const ref = (match[2] ?? '').replace(/^(['"])(.*)\1$/u, '$2');
    if (ref === '' || ref.startsWith('./')) continue;
    // The security rerun at 356dbe5, N2: a `docker://` step was skipped, so a
    // step image on a movable tag passed. It runs a container like `image:`
    // does, so it is held to the same digest and the same record.
    if (ref.startsWith('docker://')) {
      const image = ref.slice('docker://'.length);
      if (DIGESTED.exec(image)?.groups === undefined) {
        failures.push(
          `${file}: the step image ${ref} is not pinned to a sha256 digest.\n` +
            '        Pin it as `docker://image@sha256:<64 hex>` and record it.',
        );
        continue;
      }
      images.set(image, file);
      continue;
    }
    const pinned = PINNED.exec(ref);
    if (pinned?.groups === undefined) {
      failures.push(
        `${file}: ${ref} is not pinned to a 40 character commit hash.\n` +
          '        A tag can be moved by whoever owns it. A hash cannot.',
      );
      continue;
    }
    pins.set(ref, `${file}`);
  }
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    const match = IMAGE.exec(line);
    if (match?.groups === undefined) continue;
    const { key = '' } = match.groups;
    const ref = (match.groups['value'] ?? '')
      .replace(/(?:^|\s)#.*$/u, '')
      .trim()
      .replace(/^(['"])(.*)\1$/u, '$2');
    if (ref === '') {
      const next = lines.slice(i + 1).find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
      if (key === 'container' && next !== undefined && MAPPING_KEY.test(next)) continue;
      failures.push(
        `${file}:${i + 1}: \`${key}:\` names no image on its line.\n` +
          '        Write the image, pinned to a sha256 digest, on the same line.',
      );
      continue;
    }
    if (ref.includes('${{')) {
      failures.push(
        `${file}:${i + 1}: the container image ${ref} is an expression.\n` +
          '        It chooses the image at run time, so no digest here pins it.\n' +
          '        Write the image itself: `image@sha256:<64 hex>`.',
      );
      continue;
    }
    const digested = DIGESTED.exec(ref);
    if (digested?.groups === undefined) {
      failures.push(
        `${file}:${i + 1}: the container image ${ref} is not pinned to a sha256 digest.\n` +
          '        A service container runs code in the job. Pin it the way an\n' +
          '        action is pinned: `image@sha256:<64 hex>`, with the tag it\n' +
          '        came from in a comment beside it.',
      );
      continue;
    }
    images.set(ref, file);
  }
}

console.log(
  `pins: ${pins.size} pinned action reference(s) and ${images.size} pinned image(s) ` +
    `across ${workflows.length} workflow(s)`,
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
