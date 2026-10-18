// SPDX-License-Identifier: AGPL-3.0-only
//
// A planted fault for the-timeout-proof-catches-a-descendant-that-outlives-its-parent.test.ts,
// loaded only by the config that test writes: a kill of a process group (a negative pid) reaches
// its leader alone, so a descendant holding the child's stdout outlives the timeout. No product
// file changes.

const kill = process.kill.bind(process);
process.kill = ((pid: number, signal?: NodeJS.Signals | number) =>
  kill(pid < 0 ? -pid : pid, signal)) as typeof process.kill;
