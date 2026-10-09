// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Run = {
  child: { spawnargs: string[]; kill: (signal: string) => boolean };
  exited: Promise<boolean>;
  stop: () => Promise<void>;
};

/**
 * A stand-in docker whose `run` does `create`. Its `rm` removes, except that
 * after the first `okFirst` it refuses `rmFailures` times with `refusal`.
 */
export function standIn(
  bin: string,
  create: string[],
  rmFailures = 0,
  {
    okFirst = 0,
    refusal = 'Error response from daemon: transient',
  }: { okFirst?: number; refusal?: string } = {},
): void {
  const calls = join(bin, 'calls');
  const containers = join(bin, 'containers');
  const failures = join(bin, 'rm-failures');
  const oks = join(bin, 'rm-oks');
  writeFileSync(calls, '');
  writeFileSync(failures, String(rmFailures));
  writeFileSync(oks, String(okFirst));
  rmSync(containers, { recursive: true, force: true });
  mkdirSync(containers);
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      `if [ "$1" = rm ]; then echo "$*" >> "${calls}"; for last; do :; done`,
      `  ok=$(cat "${oks}"); if [ "$ok" -gt 0 ]; then echo $((ok - 1)) > "${oks}"; rm -f "${containers}/$last"; exit 0; fi`,
      `  left=$(cat "${failures}"); if [ "$left" -gt 0 ]; then echo $((left - 1)) > "${failures}"`,
      `    echo '${refusal}' >&2; exit 1; fi`,
      `  rm -f "${containers}/$last"; exit 0; fi`,
      `if [ "$1" = kill ]; then echo "$*" >> "${calls}"; exit 0; fi`,
      'for arg in "$@"; do case $arg in --cidfile=*) cid="${arg#--cidfile=}" ;; --name=*) name="${arg#--name=}" ;; esac; done',
      ': > "$cid"',
      ...create,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
}
