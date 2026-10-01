// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: the instruction root the accept reads from. The server holds a
// read-only directory; a path is a plain relative name inside it, and a
// symlink at any segment, a name that resolves outside the root, a directory
// or a missing file reads as nothing, which the accept's manifest capture
// answers `DEFINITION_UNAVAILABLE`.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  configuredInstructionSource,
  directorySource,
  INSTRUCTION_ROOT_VARIABLE,
} from '../../packages/core-runtime/src/index.ts';

const outside = mkdtempSync(join(tmpdir(), 'aw04-outside-'));
const root = mkdtempSync(join(tmpdir(), 'aw04-root-'));
mkdirSync(join(root, 'skills', 'brief'), { recursive: true });
mkdirSync(join(root, 'skills', 'shared'), { recursive: true });
writeFileSync(join(root, 'skills', 'brief', 'SKILL.md'), '# Brief\n');
writeFileSync(join(root, 'skills', 'shared', 'preamble.md'), 'Plain words.\n');
writeFileSync(join(outside, 'secret.md'), 'outside the root\n');
mkdirSync(join(outside, 'dir'));
writeFileSync(join(outside, 'dir', 'SKILL.md'), 'through a linked directory\n');
// A link to a file inside the root, one to a file outside it, and a linked directory.
symlinkSync(join(root, 'skills', 'brief', 'SKILL.md'), join(root, 'skills', 'inside-link.md'));
symlinkSync(join(outside, 'secret.md'), join(root, 'skills', 'outside-link.md'));
symlinkSync(join(outside, 'dir'), join(root, 'skills', 'linked'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const text = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

describe('the instruction root', () => {
  const source = directorySource(root);

  it('reads a plain relative path inside the root, bytes as stored', async () => {
    expect(text(await source.read('skills/brief/SKILL.md'))).toBe('# Brief\n');
    expect(text(await source.read('skills/shared/preamble.md'))).toBe('Plain words.\n');
  });

  it('refuses a symlink at any segment, inside or outside the root', async () => {
    expect(await source.read('skills/inside-link.md')).toBeUndefined();
    expect(await source.read('skills/outside-link.md')).toBeUndefined();
    expect(await source.read('skills/linked/SKILL.md')).toBeUndefined();
  });

  it('refuses a name that leaves the root or is not a plain path', async () => {
    const hostile = [
      '../secret.md',
      'skills/../../secret.md',
      `${outside}/secret.md`,
      '/etc/passwd',
      'skills/./brief/SKILL.md',
      'skills/brief/SKILL.md\t',
      'skills\tbrief/SKILL.md',
      '%2e%2e/secret.md',
      'skills/%2e%2e/brief/SKILL.md',
      'skills\\brief\\SKILL.md',
      'skills/brief/SKILL.md\u0000',
      'skills/brïef/SKILL.md',
      '',
      'skills//brief/SKILL.md',
    ];
    for (const path of hostile) {
      // eslint-disable-next-line no-await-in-loop
      expect(await source.read(path), JSON.stringify(path)).toBeUndefined();
    }
  });

  it('reads a directory or a missing file as nothing', async () => {
    expect(await source.read('skills/brief')).toBeUndefined();
    expect(await source.read('skills/brief/MISSING.md')).toBeUndefined();
  });
});

describe('the configured instruction root', () => {
  it('is configured by an absolute root on the process, or not at all', () => {
    expect(configuredInstructionSource({})).toBeUndefined();
    expect(configuredInstructionSource({ [INSTRUCTION_ROOT_VARIABLE]: '' })).toBeUndefined();
    expect(
      configuredInstructionSource({ [INSTRUCTION_ROOT_VARIABLE]: 'relative/root' }),
    ).toBeUndefined();
    expect(configuredInstructionSource({ [INSTRUCTION_ROOT_VARIABLE]: root })).toBeDefined();
  });

  it('a root that does not exist reads nothing', async () => {
    const missing = directorySource(join(outside, 'no-such-root'));
    expect(await missing.read('skills/brief/SKILL.md')).toBeUndefined();
  });
});
