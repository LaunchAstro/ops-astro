// SPDX-License-Identifier: AGPL-3.0-only
//
// T2c1, the crash seam. Red-first stub: the shapes only.

export const CRASH_POINT_VARIABLE = 'OPS_ASTRO_CRASH_POINT';
export const CRASH_POINTS = [] as const;
type Environment = Readonly<Record<string, string | undefined>>;

export function crashSeamProblem(_env: Environment): string | undefined {
  return undefined;
}

export async function crashPoint(_name: string, _env: Environment): Promise<void> {
  // Not built yet.
}

export async function crashPointAfterCommit(
  _command: string,
  _applied: boolean,
  _env: Environment,
): Promise<void> {
  // Not built yet.
}
