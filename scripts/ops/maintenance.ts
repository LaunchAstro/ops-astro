// SPDX-License-Identifier: AGPL-3.0-only
//
// The maintenance deployment's build output (ticket S0-6's owner check and
// case R8; the promotion's first step under O-1). One static page for every
// path, nothing that runs and nothing from records, in Vercel's Build Output
// API layout, version 3. `web-deploy.mjs --maintenance` puts it on the main
// address; deploying a version again takes it off.
//
// The page answers 200, so the watcher's web check stays green while it is up.
// It carries `MAINTENANCE_MARKER`, which no page of the app carries, and the
// watcher's keyword check alerts while the marker is there (`alerts.mjs plan`).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** On the maintenance page and nowhere in the app: the watcher's keyword. */
export const MAINTENANCE_MARKER = 'ops-astro-maintenance-page';

const PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="${MAINTENANCE_MARKER}" content="on">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ops Astro: down for maintenance</title>
<p>Ops Astro is down for maintenance. Please try again shortly.</p>
</html>
`;

/** Writes the maintenance build output at `out`. */
export function writeMaintenanceOutput(out: string): void {
  mkdirSync(join(out, 'static'), { recursive: true });
  writeFileSync(join(out, 'static', 'index.html'), PAGE);
  const routes = [{ handle: 'filesystem' }, { src: '^/.*$', dest: '/index.html' }];
  writeFileSync(join(out, 'config.json'), JSON.stringify({ version: 3, routes }));
}
