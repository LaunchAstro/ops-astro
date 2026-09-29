// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1: a planted credential canary never reaches a journey case line.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { tokenFor } from '../acceptance/world.ts';
import { holdSecret, redact } from './redact.ts';

describe('the journey redacts what it holds', () => {
  it('replaces a held delegation credential and any signed token in a failure detail', async () => {
    const canary = holdSecret(`dlg-canary-${randomUUID()}`);
    const token = await tokenFor(`canary-${randomUUID()}`);
    const detail = `refused: {"credential":"${canary}"} bearer ${token}`;
    const printed = redact(detail);
    expect(printed).not.toContain(canary);
    expect(printed).not.toContain(token);
    expect(printed).toBe('refused: {"credential":"<credential>"} bearer <token>');
  });
});
