// SPDX-License-Identifier: AGPL-3.0-only
//
// The before-and-after report of the machine's services (ticket S0-1).
//
// Staging is prepared on the installation's own production machine, and the
// one promise that makes that acceptable is that preparing it stops, restarts
// or reconfigures no live service. This is the check the owner runs either
// side of the preparation: a snapshot before, a snapshot after, and a compare
// that goes red on any live service that stopped, restarted, vanished, moved
// port, changed image or was reconfigured. Staging's own services, named by
// the prefix in deploy/staging/compose.json, are listed and never counted.
//
// It reads two service managers: Docker's containers and launchd's jobs.
// Apple's own launchd jobs start and stop on demand and are not services of
// this installation, so they are left out. What it keeps is names, state,
// start times, images, ports and a 16-hex digest of each container's whole
// configuration and network endpoints, so a changed limit, mount or address
// shows without a restart. It never copies an environment, arguments or an
// address, so no snapshot or report carries a credential (credentials canary).
//
// Usage:
//   node scripts/ops/service-report.mjs snapshot [--docker-inspect <file>] [--launchctl <file>]
//   node scripts/ops/service-report.mjs compare <before.json> <after.json>
//
// With no file, snapshot asks `docker inspect` and `launchctl list` itself; a
// file holds that command's raw output instead. It inspects the containers a
// batch at a time and keeps only each batch's fields, so the snapshot does not
// grow with the size of all of Docker's output (161 containers printed 1.7 MB
// on the production machine, past Node's default 1 MB buffer). A command that
// fails stops the snapshot with its own error, exit 2, and prints nothing.
// Compare exits 0 when every live service is unchanged, 1 when one is not, and
// 2 when it cannot read a snapshot, so a broken input is never green.
//
// The deploy and the promotion import `snapshot` and `compare` and use them as
// the command does; `compare` throws where the command exits 2.

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

const INSPECT_BATCH = 32;
const CONTAINER_ID = /^[0-9a-f]{64}$/u;

/** A command's output; its failure carries the command's own error, never its output. */
function ask(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const said = typeof error.stderr === 'string' ? error.stderr.trim() : '';
    // oxlint-disable-next-line preserve-caught-error -- its stdout can hold a container's environment
    throw new Error(`${command} ${args[0]} failed: ${said || error.code || error.message}`);
  }
}

/** Every container, running or not, inspected a batch at a time. */
function dockerServices() {
  const ids = ask('docker', ['ps', '-aq', '--no-trunc']).split('\n').filter(Boolean);
  if (!ids.every((id) => CONTAINER_ID.test(id)))
    throw new Error('docker ps printed something other than container ids');
  const services = [];
  for (let at = 0; at < ids.length; at += INSPECT_BATCH)
    services.push(...fromDocker(ask('docker', ['inspect', ...ids.slice(at, at + INSPECT_BATCH)])));
  return services;
}

function fromDocker(raw) {
  return JSON.parse(raw).map((container) => {
    const networks = Object.entries(container.NetworkSettings?.Networks ?? {}).toSorted();
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
        .update(JSON.stringify([container.Config ?? null, container.HostConfig ?? null, networks]))
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

/** The live services as a snapshot, printed; a file holds its command's raw output instead. */
export function snapshot({ dockerFile, launchdFile } = {}) {
  const docker = dockerFile ? fromDocker(readFileSync(dockerFile, 'utf8')) : dockerServices();
  const launchd = launchdFile ? readFileSync(launchdFile, 'utf8') : ask('launchctl', ['list']);
  const services = [...docker, ...fromLaunchd(launchd)];
  return JSON.stringify({ taken: new Date().toISOString(), services }, undefined, 2);
}

function load(text, which) {
  let services;
  try {
    ({ services } = JSON.parse(text));
  } catch {
    // Not JSON, or `null`: refused below.
  }
  if (!Array.isArray(services)) throw new Error(`the ${which} snapshot is not a snapshot`);
  return new Map(services.map((s) => [`${s.manager} ${s.name}`, s]));
}

/** Two printed snapshots compared: `unchanged` when every live service is, and the report. */
export function compare(beforeText, afterText) {
  const before = load(beforeText, 'before');
  const after = load(afterText, 'after');
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
  const lines = [`${before.size} services before, ${after.size} after`];
  if (staging.length > 0) lines.push(`staging's own: ${staging.join(', ')}`);
  if (added.length > 0) lines.push(`new, not staging's: ${added.join(', ')}`);
  lines.push(
    ...changed,
    `${unchanged} live services unchanged`,
    changed.length > 0
      ? `RED, ${changed.length} change(s) to live services`
      : 'GREEN, every live service unchanged',
  );
  const report = lines.map((line) => `service-report: ${line}`).join('\n');
  return { unchanged: changed.length === 0, report };
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'snapshot') {
    let taken;
    try {
      taken = snapshot({
        dockerFile: flag(rest, '--docker-inspect'),
        launchdFile: flag(rest, '--launchctl'),
      });
    } catch (error) {
      refuse(`no snapshot: ${error.message}`);
    }
    console.log(taken);
  } else if (command === 'compare') {
    if (rest.length !== 2) refuse('compare needs a before and an after snapshot');
    let compared;
    try {
      compared = compare(readFileSync(rest[0], 'utf8'), readFileSync(rest[1], 'utf8'));
    } catch (error) {
      refuse(`${error.message}; nothing is compared`);
    }
    console.log(compared.report);
    if (!compared.unchanged) process.exitCode = 1;
  } else {
    refuse(
      'usage: service-report.mjs snapshot [--docker-inspect f] [--launchctl f] | compare <before> <after>',
    );
  }
}
