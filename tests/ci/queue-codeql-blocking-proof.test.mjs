// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const rules = JSON.parse(read('.github/required-checks.json'));
const workflow = read('.github/workflows/codeql.yml');

// GitHub's code-scanning rules do not apply to merge queue groups:
// https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection
// A failed analysis must therefore have a required status-check path of its own.
function missingRequiredAnalyses(required, emitted) {
  return emitted.filter((context) => !required.some((check) => check.context === context));
}

test('failed CodeQL analyses block the merge queue', () => {
  assert.match(workflow, /^  merge_group:$/m);
  assert.match(workflow, /github\/codeql-action\/analyze@/);
  assert.match(workflow, /^    name: Analyze \(\$\{\{ matrix.language \}\}\)$/m);
  const languages = /^        language: \[(.+)\]$/m.exec(workflow)?.[1].split(', ');
  assert.deepEqual(languages, ['actions', 'javascript-typescript', 'python']);
  const emitted = languages.map((language) => `Analyze (${language})`);

  // Positive control: requiring the actual emitted checks closes this specific gap.
  const protectedRules = [
    ...rules.required_status_checks,
    ...emitted.map((context) => ({ context, integration_id: 15368 })),
  ];
  assert.deepEqual(missingRequiredAnalyses(protectedRules, emitted), []);
  assert.deepEqual(
    missingRequiredAnalyses(rules.required_status_checks, emitted),
    [],
    'CodeQL analysis failures are unrequired; the code_scanning rule cannot block a merge group',
  );
});
