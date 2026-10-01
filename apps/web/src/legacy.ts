// SPDX-License-Identifier: AGPL-3.0-only
//
// Legacy addresses, the mockup's (R5): answered with their canonical one,
// never drawn, linked or stored.

import { PAGES, fill } from './manifest.ts';
import { pathTo } from './routes.ts';

/** A mockup source address: never drawn, linked or stored. */
export const isLegacy = (address: string): boolean =>
  /^\/(?:agency|client-portal)\//u.test(address);

/**
 * The canonical address for a known legacy one, else null: the hash picks the
 * tab, `?client=` the client (none goes to the client list), and the canonical
 * address then passes the same grant check as any other.
 */
export function canonicalOf(address: string): string | null {
  const url = new URL(address, 'http://address.invalid');
  const path = url.pathname.replace(/\/?$/u, '/');
  const client = url.searchParams.get('client');
  const task = url.searchParams.get('task');
  if (path === '/agency/task/')
    return task === null ? null : pathTo('agency:task-detail', { key: task });
  const sources = PAGES.filter((page) => page.legacy !== '' && page.legacy.split('#')[0] === path);
  const chosen =
    sources.find((page) => url.hash !== '' && page.legacy.endsWith(url.hash)) ??
    sources.find((page) => !page.legacy.includes('#')) ??
    sources[0];
  if (chosen === undefined) return null;
  if (!chosen.path.includes(':client')) return chosen.path;
  return client === null ? '/clients/' : fill(chosen.path, encodeURIComponent(client));
}
