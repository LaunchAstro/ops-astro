// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1: a planted credential canary never reaches a journey case line.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { holdSecret, redact } from './redact.ts';

/** Shaped as a signed token's parts are, so this pure suite reaches no database harness. */
const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('the journey redacts what it holds', () => {
  it('replaces a held delegation credential and any signed token in a failure detail', () => {
    const canary = holdSecret(`dlg-canary-${randomUUID()}`);
    const token = `${part({ alg: 'HS256' })}.${part({ sub: randomUUID() })}.${part({ sig: randomUUID() })}`;
    const detail = `refused: {"credential":"${canary}"} bearer ${token}`;
    const printed = redact(detail);
    expect(printed).not.toContain(canary);
    expect(printed).not.toContain(token);
    expect(printed).toBe('refused: {"credential":"<credential>"} bearer <token>');
  });
});
