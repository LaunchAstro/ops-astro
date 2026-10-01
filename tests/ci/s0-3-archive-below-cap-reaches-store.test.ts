// SPDX-License-Identifier: AGPL-3.0-only

import { constants } from 'node:buffer';
import { describe, expect, it } from 'vitest';

describe('S0-3 store reach', () => {
  it('an archive below the store cap can reach the store', async () => {
    const path = '../../scripts/ops/backup-store-reach.mjs';
    const { value } = (await import(/* @vite-ignore */ path)) as {
      value: (archive: Buffer, type: string) => string;
    };
    // Hex needs two characters per byte. This valid archive is about 256 MiB,
    // well below backups.settings.max_bytes (4 GiB), but exceeds V8's string limit.
    const archive = Buffer.alloc(Math.floor(constants.MAX_STRING_LENGTH / 2) + 1);
    expect(() => value(archive, 'bytea')).not.toThrow();
  });
});
