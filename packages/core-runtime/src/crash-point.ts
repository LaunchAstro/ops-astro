// SPDX-License-Identifier: AGPL-3.0-only
//
// The crash seam (T2c1, spike RN-02). An outside kill timed off an observed
// mark landed in only 14 to 43 of 50 runs; a process parked at a named point
// and then killed landed 50 of 50. So a test names a point, the API parks
// there once the transaction before it has committed, and the test kills it.
//
// Two points, both in the API after the envelope's commit: the reservation a
// decision commits, and the dispatch mark, which is also the lost-response gap
// between the API committing and the worker receiving its answer.
//
// Inert unless `OPS_ASTRO_CRASH_POINT` names a point, and refused outside
// test mode: the API will not start with it set (`crashSeamProblem`), and a
// point reached with it set outside test mode throws rather than parks.

export const CRASH_POINT_VARIABLE = 'OPS_ASTRO_CRASH_POINT';
export const CRASH_POINTS = ['reservation_committed', 'dispatch_committed'] as const;
export type CrashPointName = (typeof CRASH_POINTS)[number];

type Environment = Readonly<Record<string, string | undefined>>;

const AFTER_COMMIT: Readonly<Record<string, CrashPointName>> = {
  'task.decide': 'reservation_committed',
  'task.dispatch': 'dispatch_committed',
};

/** Why this environment may not run, or `undefined` when the seam is unset or allowed. */
export function crashSeamProblem(env: Environment): string | undefined {
  const named = env[CRASH_POINT_VARIABLE] ?? '';
  if (named === '') return undefined;
  if (env['NODE_ENV'] !== 'test') {
    return `${CRASH_POINT_VARIABLE} is set outside test mode; unset it`;
  }
  if (!(CRASH_POINTS as readonly string[]).includes(named)) {
    return `${CRASH_POINT_VARIABLE} names no crash point: ${named}`;
  }
  return undefined;
}

/** Park here, for good, when the test-only variable names this point. */
export async function crashPoint(name: CrashPointName, env: Environment): Promise<void> {
  if ((env[CRASH_POINT_VARIABLE] ?? '') === '') return;
  const problem = crashSeamProblem(env);
  if (problem !== undefined) throw new Error(problem);
  if (env[CRASH_POINT_VARIABLE] !== name) return;
  process.stderr.write(`crash point ${name}: parked; kill this process\n`);
  await new Promise<never>(() => {
    // Parked until the test kills the process.
  });
}

/** The point after a command's commit, when it applied and has one. */
export async function crashPointAfterCommit(
  command: string,
  applied: boolean,
  env: Environment,
): Promise<void> {
  const point = Object.hasOwn(AFTER_COMMIT, command) ? AFTER_COMMIT[command] : undefined;
  if (applied && point !== undefined) await crashPoint(point, env);
}
