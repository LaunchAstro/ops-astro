// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const copy = new URL('../../docs/design-system/', import.meta.url);
const c82Tests = new URL('./c82-design-system-copy.test.ts', import.meta.url);

function files(folder = ''): string[] {
  return readdirSync(new URL(folder || '.', copy), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(`${folder}${entry.name}/`) : [`${folder}${entry.name}`],
  );
}

describe('Sol C82 text-only proof', () => {
  it('Sol proof, criterion 2: each locally checkable checklist line has a named test', () => {
    const names = [...readFileSync(c82Tests, 'utf8').matchAll(/\bit\(['"]([^'"]+)['"]/gu)].map(
      (match) => match[1],
    );
    expect(names.some((name) => name?.includes('CS-16.21'))).toBe(true);
    expect(names.some((name) => name?.includes('Only fresh files cross'))).toBe(true);
    expect(names.some((name) => name?.includes('synthetic replacements'))).toBe(true);
    expect(names.some((name) => name?.includes('planted name'))).toBe(true);
  });

  it('Sol proof, criterion 3: each retaken group has a reported synthetic source', () => {
    const reports = files()
      .filter((name) => /report|manifest/iu.test(name))
      .map((name) => readFileSync(new URL(name, copy), 'utf8'));
    const report = reports.find((text) => text.includes('SG-1') && text.includes('SG-4'));
    expect(report, 'No kept text-only retake report covers SG-1 to SG-4').toBeDefined();
    for (const group of ['SG-1', 'SG-2', 'SG-3', 'SG-4']) {
      expect(
        report
          ?.split('\n')
          .some((line) => line.includes(group) && /synthetic|reserved/iu.test(line)),
        `${group} lacks its synthetic data source in the retake report`,
      ).toBe(true);
    }
  });
});

describe('Sol C82 real-names proof', () => {
  it('Sol proof, criterion 4: the kept real-names report covers every copied file with zero hits', () => {
    const copied = files().filter((name) => name !== 'COPY-RECORD.md');
    const report = files()
      .map((name) => readFileSync(new URL(name, copy), 'utf8'))
      .find((text) => /files copied/iu.test(text) && /names checked/iu.test(text));
    expect(report, 'No kept real-names report states files copied and names checked').toBeDefined();
    expect(report).toMatch(/hits\s*[:|]\s*0\b/iu);
    for (const name of copied) {
      expect(report, `The real-names report omits ${name}`).toContain(name);
    }
  });
});
