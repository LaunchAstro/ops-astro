// SPDX-License-Identifier: AGPL-3.0-only
//
// How the command line puts a credential in a file: whole, owner-only from its
// first byte, or not at all. The value goes into a file of its own beside the
// target, made only if no file or link of that name exists, and is renamed
// over the target. A rename replaces a link at the target rather than writing
// through it, and a reader sees the earlier file or the whole new one, never
// part of either. Nothing is chmodded after the write and nothing is left
// behind when a step fails.

import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Puts `value` and a newline in `file`, readable and writable by its owner alone. */
export function publishSecret(file: string, value: string): void {
  const folder = dirname(file);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const own = join(folder, `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  // `wx`: made here or not at all, never an existing file or a link's target.
  const fd = openSync(own, 'wx', 0o600);
  try {
    try {
      writeSync(fd, `${value}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(own, file);
  } catch (cause) {
    rmSync(own, { force: true });
    throw cause;
  }
}
