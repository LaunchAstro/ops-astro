// SPDX-License-Identifier: AGPL-3.0-only
// STUB for the red run.

export function migrationId(version: string): string | undefined {
  return /^(\d{4}|\d{14})_/u.exec(version)?.[1];
}

export function migrationIdProblems(_versions: readonly string[]): readonly string[] {
  return [];
}
