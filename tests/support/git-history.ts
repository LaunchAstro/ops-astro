// SPDX-License-Identifier: AGPL-3.0-only
//
// How much git history a tree carries. A test that reads history runs only
// on `full`: a shallow clone lacks the older commits, and a source export has
// none. An export unpacked inside another repository's work tree is still an
// export: git would answer from the outer repository, so the tree must be
// the work tree's own top level.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export type GitHistory = 'full' | 'shallow' | 'none';

export function gitHistory(dir: string): GitHistory {
  let answer: string[];
  try {
    answer = execFileSync('git', ['rev-parse', '--show-toplevel', '--is-shallow-repository'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n');
  } catch {
    return 'none';
  }
  const [top, shallow] = answer;
  if (top === undefined || realpathSync(top) !== realpathSync(dir)) return 'none';
  return shallow === 'false' ? 'full' : 'shallow';
}
