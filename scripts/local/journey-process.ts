// SPDX-License-Identifier: AGPL-3.0-only
//
// A test-side run of the journey command as its own process (scripts may not
// import tests): the journey (`tests/journey/run.ts`) or T4e's self-test
// (`tests/ci/self-test/run.ts`). Each prints one line per case on its stdout,
// handed to `take` whole; its stderr goes to the evidence with the database
// password scrubbed.

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export interface TestSide {
  readonly root: string;
  readonly file: string;
  readonly env: NodeJS.ProcessEnv;
  /** The command's pid file: the run's process group is written there before anything else. */
  readonly pidfile: string;
  readonly stderr: string;
  readonly password: string;
  readonly take: (line: string) => void;
}

/** Resolves with the run's exit code once it has closed. */
export async function runTestSide(side: TestSide): Promise<number | null> {
  const child = spawn(process.execPath, [side.file], {
    cwd: side.root,
    env: { ...process.env, ...side.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group: the API and CLI processes it starts join it, so
    // the command stops the group and never a pid that may be reused.
    detached: true,
  });
  appendFileSync(side.pidfile, `-${String(child.pid)} ${side.file} (process group)\n`);
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const complete = buffer.split('\n');
    buffer = complete.pop() ?? '';
    for (const line of complete) side.take(line);
  });
  // Whole lines, so the password cannot be split across two writes and pass the scrub.
  let errors = '';
  const scrubbed = (text: string): string => text.replaceAll(side.password, '<password>');
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString('utf8');
    const cut = errors.lastIndexOf('\n') + 1;
    appendFileSync(side.stderr, scrubbed(errors.slice(0, cut)));
    errors = errors.slice(cut);
  });
  const code = await new Promise<number | null>((done) => {
    child.once('close', done);
  });
  appendFileSync(side.stderr, scrubbed(errors));
  return code;
}
