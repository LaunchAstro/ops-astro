// SPDX-License-Identifier: AGPL-3.0-only
//
// A process the restart proof started, written down for its exit trap
// (scripts/local/restart-proof.sh): its pid and the time it started, as `ps`
// prints it. The trap signals the pid only while that same start time still
// stands beside it, so a pid reused by another process is never signalled.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/** The start time `ps` gives `pid`, spaces collapsed, or '' once it has gone. */
const startOf = (pid: number): string =>
  spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
    .stdout.trim()
    .replaceAll(/\s+/gu, ' ');

/** Appends `pid` and its start time to the proof's pid file, when the run names one. */
export function recordProofPid(pid: number | undefined): void {
  const pidFile = process.env['L5_RESTART_PIDFILE'];
  if (pidFile !== undefined && pid !== undefined)
    appendFileSync(pidFile, `${pid} ${startOf(pid)}\n`);
}
