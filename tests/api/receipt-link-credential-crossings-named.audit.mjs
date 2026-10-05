// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseSync } from 'vite';

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const paths = execFileSync('git', ['grep', '-l', 'agentCredentials', head, '--', 'tests'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .map((line) => line.slice(head.length + 1));
const titles = [];
const visit = (node) => {
  if (node === null || typeof node !== 'object') return;
  if (node.type === 'CallExpression') {
    const name = node.callee?.name;
    const title = node.arguments?.[0];
    if (['it', 'test', 'vitestIt'].includes(name) && typeof title?.value === 'string') {
      titles.push(title.value);
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => visit(child));
    else if (value !== null && typeof value === 'object') visit(value);
  }
};
for (const path of paths) {
  const source = execFileSync('git', ['show', `${head}:${path}`], { encoding: 'utf8' });
  if (
    !/import\s*\{[^}]*\bagentCredentials\b[^}]*\}\s*from\s*['"][^'"]*\/receipt-link\.ts['"]/u.test(
      source,
    )
  )
    continue;
  visit(parseSync(path, source, { lang: 'ts' }).program);
}
assert.ok(titles.length > 0, 'the audit must discover actual credential enumeration test cases');
const required = ['business to business', 'person to person'];
const missing = required.filter((boundary) => !titles.some((title) => title.includes(boundary)));
assert.deepEqual(
  missing,
  [],
  'live credential enumeration has named business to business and person to person crossing tests',
);
