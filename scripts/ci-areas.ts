// SPDX-License-Identifier: AGPL-3.0-only
// The area a repository path belongs to, derived from the path alone.
//
// Files every lane edits are split into one file per area (code-factory
// METHOD Phase 2 step 6): the named suites in tests/db/named-suites/ and the
// lint baseline in lint-baseline/. The area comes from the path, so no list
// has to be kept and no path is ever left without one: `tests/<dir>`,
// `apps/<x>` and `packages/<y>` take their first two segments
// (`tests-runtime`, `apps-web`), any other path its first segment without a
// leading dot (`scripts`, `github`), and a file at the root is `root`.

const SPLIT_TWO = new Set(['tests', 'apps', 'packages']);

/** The area of a path relative to the repository root. */
export const areaOf = (path: string): string => {
  const segments = path.replaceAll('\\', '/').replace(/^\.\//u, '').split('/');
  if (path === '' || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`"${path}" is not a repository path`);
  }
  const [first = '', second] = segments;
  if (segments.length === 1) return 'root';
  if (SPLIT_TWO.has(first) && segments.length > 2) return `${first}-${String(second)}`;
  return first.replace(/^\.+/u, '');
};
