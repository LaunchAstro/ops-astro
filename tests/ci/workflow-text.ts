// SPDX-License-Identifier: AGPL-3.0-only
// Reading a workflow file as text, for the cases that check what a job runs.

/** A top-level key's block, from `key:` to the next line that starts in column one. */
export function top(text: string, key: string): string {
  return new RegExp(`^${key}:.*\\n(?:(?: .*)?\\n)*`, 'mu').exec(text)?.[0] ?? '';
}

/** One step of a job, from its `- name:` line to the next step. */
export function step(block: string, name: string): string {
  const start = block.indexOf(`      - name: ${name}\n`);
  if (start === -1) return '';
  const next = block.slice(start + 1).search(/^ {6}- /mu);
  return block.slice(start, next === -1 ? undefined : start + 1 + next);
}

/** A step's `run: |` script, unindented. */
export function script(block: string): string {
  const lines = block.split('\n');
  const at = lines.findIndex((l) => /^ {8}run: \|$/u.test(l));
  const body = lines.slice(at + 1).filter((l) => l === '' || l.startsWith('          '));
  return at === -1 ? '' : body.map((l) => l.slice(10)).join('\n');
}
