// SPDX-License-Identifier: AGPL-3.0-only
//
// How deep a parsed JSON value nests, judged from the value's own list rather
// than the call stack, so a value of any depth is judged without a RangeError.

/** Whether `value` nests arrays or objects `most` levels deep or more. */
export function nestsTooDeep(value: unknown, most: number): boolean {
  const pending: [unknown, number][] = [[value, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [item, depth] = next;
    if (typeof item !== 'object' || item === null) continue;
    if (depth >= most) return true;
    for (const child of Object.values(item)) pending.push([child, depth + 1]);
  }
  return false;
}
