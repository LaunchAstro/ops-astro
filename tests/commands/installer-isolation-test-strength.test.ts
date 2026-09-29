// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('tests/commands/cq-11.test.ts', 'utf8');

describe('CQ-11 review proofs', () => {
  it('the visibility upgrade crosses the client read boundary', () => {
    const upgraded =
      source
        .split("it('CQ-11 isolation: the installer")[1]
        ?.split("it('CQ-11 canary: planted record content")[0] ?? '';

    expect(upgraded, 'check the client-facing read after upgrading title and state').toMatch(
      /task\.read|readSharedTask/u,
    );
    expect(upgraded, 'try another business and another client after the upgrade').toMatch(
      /\.client[\s\S]*\.client/u,
    );
  });

  it('the canary is planted as record content before cross-boundary reads', () => {
    const canary =
      source.split("it('CQ-11 canary: planted record content")[1]?.split('\n  });')[0] ?? '';

    expect(canary, 'store the canary in a task before probing for leaks').toMatch(
      /command:\s*'task\.(?:create|update)'[\s\S]*?fields:\s*\{[^}]*canary/u,
    );
    expect(canary).toMatch(/task\.read|readSharedTask/u);
  });
});
