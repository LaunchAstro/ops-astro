// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's plan token file (#1620): its shape, read back only when no one
// else may read it, and written owner-only as a new file renamed over the
// old, leaving no copy behind when the write or the rename fails. The sign-in
// writes only what this reader accepts (`isPlanTokens`).

import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { PlanRefusal } from './plan-token.ts';

export interface PlanTokens {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Milliseconds since the epoch, on the machine's clock. */
  readonly expiresAt: number;
  /** The account the sign-in's validated ID token named, kept across refreshes. */
  readonly subject?: string;
}

/** Visible ASCII, as a token is written; a provider's access token may be long. */
export const TOKEN_TEXT: RegExp = /^[!-~]{8,32768}$/u;

/** The shape custody reads back: every token visible ASCII, the expiry a whole number. */
export function isPlanTokens(value: unknown): value is PlanTokens {
  if (typeof value !== 'object' || value === null) return false;
  const { clientId, accessToken, refreshToken, expiresAt, subject } = value as Record<
    string,
    unknown
  >;
  return (
    [clientId, accessToken, refreshToken].every(
      (text) => typeof text === 'string' && TOKEN_TEXT.test(text),
    ) &&
    typeof expiresAt === 'number' &&
    Number.isSafeInteger(expiresAt) &&
    (subject === undefined || typeof subject === 'string')
  );
}

/** The file's tokens, or why they cannot be used: open to others, or not the shape. */
export function readTokenFile(file: string): PlanTokens | PlanRefusal {
  try {
    if ((statSync(file).mode & 0o077) !== 0) return 'SUBSCRIPTION_TOKEN_FILE_OPEN';
    const shape: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isPlanTokens(shape)) return 'SUBSCRIPTION_SIGN_IN_NEEDED';
    const { clientId, accessToken, refreshToken, expiresAt, subject } = shape;
    return {
      clientId,
      accessToken,
      refreshToken,
      expiresAt,
      ...(subject === undefined ? {} : { subject }),
    };
  } catch {
    return 'SUBSCRIPTION_SIGN_IN_NEEDED';
  }
}

/** Write the tokens owner-only: a new file beside the old, renamed over it, or a throw with no copy left. */
export function writeTokenFile(file: string, tokens: PlanTokens): void {
  const next = `${file}.${randomBytes(6).toString('hex')}.next`;
  try {
    writeFileSync(next, JSON.stringify(tokens), { mode: 0o600, flag: 'wx' });
    renameSync(next, file);
  } catch (error) {
    // No copy of the tokens is left beside the file when the write or rename fails.
    rmSync(next, { force: true });
    throw error;
  }
}
