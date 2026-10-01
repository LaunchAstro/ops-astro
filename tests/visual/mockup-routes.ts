// SPDX-License-Identifier: AGPL-3.0-only
//
// The mockup's canonical addresses (`/clients/:client/account/`,
// `/clients/:client/workbench/` and the rest), resolved to the file that
// draws each, as the mockup's own server does: its `routes.json` names each
// address's source file, the most specific pattern wins, and a longer
// address counts only where its source owns the file below it. The harness
// serves the mockup from the pinned tree by file path; a canonical address
// has no file of its own, so it is served from its source.

type RouteNode = { path?: string; source?: string; children?: RouteNode[] };
type Manifest = {
  hub?: RouteNode[];
  clientWorkspace?: RouteNode[];
  clientPortal?: RouteNode[];
  utilityRoutes?: RouteNode[];
};
type Rule = { parts: string[]; source: string; fixed: number };

function nodes(list: readonly RouteNode[] | undefined): RouteNode[] {
  const out: RouteNode[] = [];
  for (const node of list ?? []) out.push(node, ...nodes(node.children));
  return out;
}

/** Every canonical pattern with its source, most specific first. */
export function routeRules(manifest: Manifest): Rule[] {
  const seen = new Set<string>();
  const rules: Rule[] = [];
  const all = [
    ...nodes(manifest.hub),
    ...nodes(manifest.clientWorkspace),
    ...nodes(manifest.clientPortal),
    ...(manifest.utilityRoutes ?? []),
  ];
  for (const { path, source } of all) {
    if (path === undefined || source === undefined || seen.has(`${path} ${source}`)) continue;
    seen.add(`${path} ${source}`);
    const parts = path.split('/').filter((part) => part !== '');
    const fixed = path.replaceAll(':client', '').replaceAll(':task', '').length;
    rules.push({ parts, source, fixed });
  }
  return rules.toSorted((a, b) => b.parts.length - a.parts.length || b.fixed - a.fixed);
}

/** The file a canonical address draws, or undefined when no rule names it. */
export function sourceOf(
  path: string,
  rules: readonly Rule[],
  exists: (file: string) => boolean,
): string | undefined {
  const last = path.split('/').at(-1) ?? '';
  const address = path.endsWith('/') || last.includes('.') ? path : `${path}/`;
  const given = address.split('/').slice(1);
  for (const { parts, source } of rules) {
    // Each part matches itself, a `:name` part any one segment; what follows is the tail.
    const matches = parts.every((part, at) => {
      const seen = given[at];
      return seen !== undefined && seen !== '' && (part.startsWith(':') || part === seen);
    });
    if (!matches || given.length <= parts.length) continue;
    const tail = given.slice(parts.length).join('/');
    const rewritten = `${source}${tail}`;
    const file = rewritten.endsWith('/') ? `${rewritten}index.html` : rewritten;
    if (tail !== '' && !exists(file)) continue;
    return file;
  }
  return undefined;
}
