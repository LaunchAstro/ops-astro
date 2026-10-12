// SPDX-License-Identifier: AGPL-3.0-only
//
// `scripts/local/trace-target.ts` run as a person runs it, from a copy of the
// script and its profile, with a stand-in `docker` first on the PATH. The
// stand-in renders the committed model for the pin check, starts nothing, and
// keeps the environment each `compose up` was given. Nothing here touches the
// repository's own `.local/trace-target.env` or a real container.

import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';

const LOCAL = resolve(import.meta.dirname, '../../scripts/local');

type Settings = Readonly<Record<string, string | undefined>>;

export interface TraceTarget {
  /** Runs `node trace-target.ts <args>` in the copy with `env` added. */
  readonly run: (args: readonly string[], env?: Readonly<Record<string, string>>) => void;
  /** The settings file the last `up` wrote. */
  readonly settings: () => Settings;
  /** The environment the last `compose up` was given. */
  readonly upEnvironment: () => Settings;
  /** Removes the copy. */
  readonly remove: () => void;
}

export function traceTarget(): TraceTarget {
  const root = mkdtempSync(join(tmpdir(), 'trace-target-'));
  mkdirSync(join(root, 'scripts', 'local'), { recursive: true });
  cpSync(join(LOCAL, 'trace-target.ts'), join(root, 'scripts', 'local', 'trace-target.ts'));
  cpSync(join(LOCAL, 'trace-target'), join(root, 'scripts', 'local', 'trace-target'), {
    recursive: true,
  });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const seen = join(root, 'up-environment');
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      'case " $* " in',
      '  *" config "*) cat profile.resolved.json ;;',
      `  *" up "*) env > '${seen}' ;;`,
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
  return {
    run: (args, env = {}) => {
      execFileSync(process.execPath, [join(root, 'scripts', 'local', 'trace-target.ts'), ...args], {
        env: { ...process.env, ...env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
        stdio: 'pipe',
      });
    },
    settings: () => readEnvFile(join(root, '.local', 'trace-target.env'), { required: true }),
    upEnvironment: () => readEnvFile(seen, { required: true }),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
