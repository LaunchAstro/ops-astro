// SPDX-License-Identifier: AGPL-3.0-only
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function publicReceipts(path, hex) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    // A missing receipt is normal in a fresh clone. A failed read is not.
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isFile()) throw new Error('invalid public record');
  const text = readFileSync(path, 'utf8');
  if (text && !new RegExp(`^(?:[0-9a-f]{${hex}} [0-9a-f]{${hex}}\\n)+$`, 'u').test(text))
    throw new Error('invalid public record');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((row) => row.split(' '));
}

export function branchHistorySelection(git, tip, branch) {
  try {
    const main = git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'])
      .toString()
      .trim();
    if (main !== branch.main) throw new Error('main changed');
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
      .toString()
      .trim();
    const rows = publicReceipts(join(common, 'gate-public-passed'), main.length);
    const reached = new Set(git(['rev-list', tip]).toString().trim().split('\n'));
    const passed = rows
      .filter(([sha, fingerprint]) => fingerprint === branch.fingerprint && reached.has(sha))
      .map(([sha]) => sha);
    const bases = [main, ...new Set(passed)];
    const seen = new Set();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const base of bases) {
      const tree = decoder.decode(git(['ls-tree', '-rz', '--full-tree', base]));
      for (const line of tree.split('\0').filter(Boolean)) {
        const split = line.indexOf('\t');
        const [mode, type, oid] = line.slice(0, split).split(' ');
        if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode))
          throw new Error('unsupported baseline entry');
        seen.add(`${oid}\0${line.slice(split + 1)}`);
      }
    }
    const selection = [tip, '--not', ...bases];
    git(['rev-list', ...selection]);
    return { selection, seen };
  } catch {
    console.log('public-content: branch state could not be read; scanning full history');
    return { selection: [tip], seen: new Set() };
  }
}
