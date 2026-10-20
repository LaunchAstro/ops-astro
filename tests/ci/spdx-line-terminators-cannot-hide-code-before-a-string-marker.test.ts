// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
// @ts-expect-error -- the checker is a JavaScript module
import { headerErrors } from '../../scripts/spdx-check.mjs';

test('a CR, LS or PS line end cannot hide code before a string marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'spdx-terminators-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(
      join(root, 'licensed.mjs'),
      '// SPDX-License-Identifier: AGPL-3.0-only\nexport {};\n',
    );
    expect(headerErrors(root)).toEqual([]);
    for (const [name, terminator] of [
      ['cr', '\r'],
      ['ls', '\u2028'],
      ['ps', '\u2029'],
    ]) {
      const file = join(root, `${name}.mjs`);
      // The real comment ends before const; the marker belongs only to the template literal.
      writeFileSync(
        file,
        `// ordinary comment${terminator}const note = \`\n// SPDX-License-Identifier: AGPL-3.0-only\n\`;\nexport default note;\n`,
      );
      execFileSync(process.execPath, ['--check', file]);
    }
    expect(headerErrors(root)).toEqual(['cr.mjs', 'ls.mjs', 'ps.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
