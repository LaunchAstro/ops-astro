// SPDX-License-Identifier: AGPL-3.0-only
//
// How the restore drill (restore-drill.mjs) runs Docker for its throwaway
// container: stdout back as text, stderr discarded, since Docker's and
// pg_restore's messages can carry record data.

import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

/**
 * Runs `docker`; stdout comes back as text, stderr is discarded. `input` is
 * bytes or a stream, written as the child takes it; the exit code decides.
 */
export function docker(args, input) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', () => resolve({ code: 1, stdout: '' }));
    child.on('close', (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString() }),
    );
    // pg_restore --list stops reading once it has the list; the rest is dropped.
    if (input?.pipe === undefined) child.stdin.end(input);
    else pipeline(input, child.stdin).catch(() => {});
  });
}

/** The step's stdout, or a bare failure. */
export async function must(result) {
  const { code, stdout } = await result;
  if (code !== 0) throw new Error('step failed');
  return stdout;
}
