// SPDX-License-Identifier: AGPL-3.0-only
//
// The before-and-after report of the machine's services (ticket S0-1).
//
// Staging is prepared on the installation's own production machine, and the
// one promise that makes that acceptable is that no live service is stopped,
// restarted or reconfigured by it. This is the check the owner runs either
// side of the preparation: a snapshot before, a snapshot after, and a compare
// that goes red on any live service that stopped, restarted, vanished, moved
// port, changed image or was reconfigured. Staging's own services, named by
// the prefix in deploy/staging/compose.json, are listed and never counted.
//
// It reads two service managers: Docker's containers and launchd's jobs.
// Apple's own launchd jobs start and stop on demand and are not services of
// this installation, so they are left out. What it keeps is names, state,
// start times, images, ports and a 16-hex digest of each container's whole
// configuration, so a changed limit, mount or setting shows without a restart.
// It never copies a container's environment or arguments, which is where
// credentials live, so neither snapshot nor report can carry one
// (`S0-1 credentials canary`).
//
// Usage:
//   node scripts/ops/service-report.mjs snapshot [--docker-inspect <file>] [--launchctl <file>]
//   node scripts/ops/service-report.mjs compare <before.json> <after.json>
//
// With no file, snapshot asks `docker inspect` and `launchctl list` itself; a
// file holds that command's raw output instead. Compare exits 0 when every
// live service is unchanged, 1 when one is not, and 2 when it cannot read a
// snapshot, so a broken input is never green.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const definition = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
);
const OWN_PREFIX = definition['x-ops-astro'].ownPrefix;
const IGNORED_LABELS = /^(?:com\.apple\.|application\.)/u;

function refuse(message) {
  console.error(`service-report: ${message}`);
  process.exit(2);
}

function flag(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

/** `docker inspect` of every container, running or not. */
function dockerInspect() {
  const ids = execFileSync('docker', ['ps', '-aq', '--no-trunc'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  if (ids.length === 0) return '[]';
  return execFileSync('docker', ['inspect', ...ids], { encoding: 'utf8' });
}

function fromDocker(raw) {
  return JSON.parse(raw).map((container) => {
    const bindings = container.HostConfig?.PortBindings ?? {};
    const ports = Object.entries(bindings).flatMap(([inside, hosts]) =>
      (hosts ?? []).map((h) => `${h.HostIp || '0.0.0.0'}:${h.HostPort}->${inside}`),
    );
    return {
      manager: 'docker',
      name: String(container.Name).replace(/^\//u, ''),
      running: container.State?.Running === true,
      started: container.State?.StartedAt ?? null,
      image: container.Image ?? null,
      ports: ports.toSorted(),
      config: createHash('sha256')
        .update(JSON.stringify([container.Config ?? null, container.HostConfig ?? null]))
        .digest('hex')
        .slice(0, 16),
    };
  });
}

function fromLaunchd(raw) {
  return raw
    .split('\n')
    .slice(1)
    .map((line) => line.split('\t'))
    .filter((cells) => cells.length === 3 && !IGNORED_LABELS.test(cells[2]))
    .map(([pid, , label]) => ({
      manager: 'launchd',
      name: label,
      running: pid !== '-',
      started: pid === '-' ? null : pid,
      image: null,
      ports: [],
      config: null,
    }));
}

function snapshot(args) {
  const dockerFile = flag(args, '--docker-inspect');
  const launchdFile = flag(args, '--launchctl');
  const docker = dockerFile ? readFileSync(dockerFile, 'utf8') : dockerInspect();
  const launchd = launchdFile
    ? readFileSync(launchdFile, 'utf8')
    : execFileSync('launchctl', ['list'], { encoding: 'utf8' });
  const services = [...fromDocker(docker), ...fromLaunchd(launchd)];
  console.log(JSON.stringify({ taken: new Date().toISOString(), services }, undefined, 2));
}

function load(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    refuse(`cannot read the snapshot ${path}; nothing is compared`);
  }
  if (!Array.isArray(parsed?.services)) refuse(`${path} is not a snapshot; nothing is compared`);
  return new Map(parsed.services.map((s) => [`${s.manager} ${s.name}`, s]));
}

function compare(args) {
  if (args.length !== 2) refuse('compare needs a before and an after snapshot');
  const before = load(args[0]);
  const after = load(args[1]);
  const own = (key) => key.split(' ')[1].startsWith(OWN_PREFIX);
  const changed = [];
  let unchanged = 0;
  for (const [key, was] of before) {
    if (own(key)) continue;
    const now = after.get(key);
    const found = [];
    if (now === undefined) found.push(`GONE ${key}`);
    else {
      if (was.running && !now.running) found.push(`STOPPED ${key}`);
      else if (was.running && was.started !== now.started)
        found.push(`RESTARTED ${key} (started ${was.started}, now ${now.started})`);
      if (was.image !== now.image) found.push(`IMAGE CHANGED ${key}`);
      if (was.config !== now.config) found.push(`RECONFIGURED ${key}`);
      if (was.ports.join() !== now.ports.join())
        found.push(`PORT CHANGED ${key} (${was.ports.join(' ')} -> ${now.ports.join(' ')})`);
    }
    if (found.length === 0) unchanged += 1;
    changed.push(...found);
  }
  const staging = [...after.keys()].filter((key) => own(key)).map((key) => key.split(' ')[1]);
  const added = [...after.keys()].filter((key) => !own(key) && !before.has(key));
  console.log(`service-report: ${before.size} services before, ${after.size} after`);
  if (staging.length > 0) console.log(`service-report: staging's own: ${staging.join(', ')}`);
  if (added.length > 0) console.log(`service-report: new, not staging's: ${added.join(', ')}`);
  for (const line of changed) console.log(`service-report: ${line}`);
  console.log(`service-report: ${unchanged} live services unchanged`);
  if (changed.length > 0) {
    console.log(`service-report: RED, ${changed.length} change(s) to live services`);
    process.exit(1);
  }
  console.log('service-report: GREEN, every live service unchanged');
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'snapshot') snapshot(rest);
else if (command === 'compare') compare(rest);
else
  refuse(
    'usage: service-report.mjs snapshot [--docker-inspect f] [--launchctl f] | compare <before> <after>',
  );
