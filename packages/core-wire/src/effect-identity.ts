// SPDX-License-Identifier: AGPL-3.0-only
//
// The operation identity of an attempt's one effect. Split from `surface.ts`,
// which re-exports both names, to keep that file under the line limit.

/**
 * The operation identity of an attempt's one effect, derived from the attempt
 * so a retry replays it and "did it happen?" is the register's answer (T2c2).
 * The worker and the server derive it here, from one spelling.
 */
export function effectOperationId(attemptId: string): string {
  return `effect:${attemptId}`;
}

/** The attempt an effect identity names, or `undefined` for any other identity. */
export function effectAttemptOf(operationId: string): string | undefined {
  const found = /^effect:([0-9a-f-]{36})$/u.exec(operationId);
  return found?.[1];
}
