// SPDX-License-Identifier: AGPL-3.0-only
//
// The type census finds off-scale text wherever the browser would apply it:
// an earlier important literal font that a later scale token cannot override,
// a quoted inline style key, an inline style after `//` inside a string, text
// a keyframe animates, and a property or at-rule name spelled with a CSS
// escape. Each planted case must fail the census by name.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const scratch = mkdtempSync(join(tmpdir(), 'type-census-hidden-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const BODY = `font: var(--type-body);
  letter-spacing: var(--type-body-tracking);
  text-transform: var(--type-body-case);`;

/** The census over one planted sheet, and one planted component file when given. */
function census(css: string, tsx?: string) {
  const sheet = join(scratch, `${String(Math.random()).slice(2)}.css`);
  writeFileSync(sheet, css);
  const args = ['--css', sheet];
  if (tsx !== undefined) {
    const file = join(scratch, `${String(Math.random()).slice(2)}.tsx`);
    writeFileSync(file, tsx);
    args.push('--tsx', file);
  }
  const run = spawnSync(process.execPath, ['scripts/type-census.mjs', ...args], {
    encoding: 'utf8',
  });
  return { status: run.status, stderr: run.stderr };
}

describe('type census finds hidden off-scale text', () => {
  it('passes the planted sheet with only the whole scale style', () => {
    expect(census(`.x {\n  ${BODY}\n}\n`).status).toBe(0);
  });

  it('refuses an earlier important literal font behind a later scale font', () => {
    const out = census(`.x {\n  font: 900 72px serif !important;\n  ${BODY}\n}\n`);
    expect(out.status, 'the important literal font wins the cascade and passed').toBe(1);
    expect(out.stderr).toContain('900 72px serif');
  });

  it('refuses a quoted inline style key', () => {
    const out = census(
      `.x {\n  ${BODY}\n}\n`,
      "export const A = () => <p style={{ 'fontSize': 99 }} />;\n",
    );
    expect(out.status, 'a quoted fontSize key passed').toBe(1);
    expect(out.stderr).toContain('fontSize');
  });

  it('refuses an inline style after // inside a string on the same line', () => {
    const tsx = "const s = 'a//b'; export const B = () => <p style={{ fontSize: 99 }} />;\n";
    const out = census(`.x {\n  ${BODY}\n}\n`, tsx);
    expect(out.status, 'the // inside a string hid the rest of the line').toBe(1);
    expect(out.stderr).toContain('fontSize');
  });

  it('refuses off-scale text a keyframe animates', () => {
    const out = census(
      `.x {\n  ${BODY}\n  animation: grow 1s;\n}\n@keyframes grow {\n  from { font-size: 99px; font-weight: 900; letter-spacing: 9px; }\n}\n`,
    );
    expect(out.status, 'the keyframe text passed unread').toBe(1);
    expect(out.stderr).toContain('font-size: 99px');
    expect(out.stderr).toContain('letter-spacing: 9px');
  });

  it('refuses off-scale text behind an escaped property name', () => {
    const out = census(`.x {\n  ${BODY}\n  f\\6fnt-size: 99px;\n}\n`);
    expect(out.status, 'the escaped font-size passed unread').toBe(1);
    expect(out.stderr).toContain('font-size: 99px');
  });

  it('refuses off-scale text inside an escaped conditional at-rule', () => {
    const out = census(
      `@m\\65 dia (min-width: 0) {\n  .x {\n    ${BODY}\n    font-size: 99px;\n  }\n}\n`,
    );
    expect(out.status, 'the escaped media block was skipped whole').toBe(1);
    expect(out.stderr).toContain('font-size: 99px');
  });
});
