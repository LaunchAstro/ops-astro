// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readBytesLocked } from '../../packages/core-custody/src/token-file.ts';
import { withTokenLock } from '../../packages/core-custody/src/token-lock.ts';
import { HOUR, T0, seed, tempDir, tokens } from './fixtures/plan-token-world.ts';

it('a raw locked token read removes a replaced refresh token copy', async () => {
  const w = tempDir();
  try {
    const old = { state: 'ready' as const, tokens: tokens('replaced', T0 + HOUR) };
    await seed(w.file, old);
    const oldBytes = readFileSync(w.file);
    await seed(w.file, { state: 'ready', tokens: tokens('current', T0 + HOUR) });
    const undo = `${w.file}.0123456789abcdef.undo`;
    writeFileSync(undo, oldBytes, { mode: 0o600 });
    const out = await withTokenLock(w.file, { deadlineAt: Date.now() + 5_000 }, (held) =>
      Promise.resolve(readBytesLocked(held, w.file)),
    );
    expect(out.held).toBe(true);
    if (!out.held) throw new Error('the control hold was refused');
    expect(Buffer.isBuffer(out.value)).toBe(true);
    expect(out.value.toString()).toContain('synthetic-refresh-current');
    expect(existsSync(undo), 'the next reading hold must remove the replaced token').toBe(false);
  } finally {
    w.done();
  }
});
