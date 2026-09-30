// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13's pinned local trace target (`scripts/local/trace-target/`): the
// vendor's compose file and environment example at the pin, byte for byte,
// the checked override, and the model they render to, which is what runs.
// `profileRefusals` names every way the profile drifts from `pin.json`: a
// vendor byte, the version, an image or its digest, the service set, a port
// off loopback, or a setting the contract fixes (telemetry off, no licence
// key, media upload and batch export off, no SSRF allowlist, AI or cloud
// variable, signup closed, every secret required from the run and never a
// default). A refusal names the service and the setting, never a value.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

interface Pin {
  readonly version: string;
  readonly vendor: Readonly<Record<string, string>>;
  readonly services: Readonly<Record<string, string>>;
}

type Service = Readonly<Record<string, unknown>>;

const LANGFUSE = ['langfuse-web', 'langfuse-worker'] as const;

/** Fixed on both Langfuse containers. */
const FIXED: Readonly<Record<string, string>> = {
  TELEMETRY_ENABLED: 'false',
  CLICKHOUSE_CLUSTER_ENABLED: 'false',
  LANGFUSE_MEDIA_UPLOAD_ENABLED: 'false',
  LANGFUSE_S3_BATCH_EXPORT_ENABLED: 'false',
};

/** Present on either Langfuse container, each of these is a refusal. */
const ABSENT =
  /^(?:LANGFUSE_EE_LICENSE_KEY|LANGFUSE_S3_MEDIA_UPLOAD_\w+|LANGFUSE_S3_BATCH_EXPORT_(?!ENABLED$)\w+|LANGFUSE_LLM_CONNECTION_WHITELISTED_\w+|LANGFUSE_AI_\w+|LANGFUSE_IN_APP_AGENT_\w+|LANGFUSE_MCP_\w+|LANGFUSE_CODE_EVAL_\w+|AWS_\w+)$/u;

/** Each secret comes from the run's own environment, required, never a default. */
const SECRETS: Readonly<Record<string, readonly string[]>> = {
  'langfuse-web': [
    'DATABASE_URL',
    'SALT',
    'ENCRYPTION_KEY',
    'CLICKHOUSE_PASSWORD',
    'LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY',
    'REDIS_AUTH',
    'NEXTAUTH_SECRET',
  ],
  'langfuse-worker': [
    'DATABASE_URL',
    'SALT',
    'ENCRYPTION_KEY',
    'CLICKHOUSE_PASSWORD',
    'LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY',
    'REDIS_AUTH',
  ],
  clickhouse: ['CLICKHOUSE_PASSWORD'],
  minio: ['MINIO_ROOT_PASSWORD'],
  postgres: ['POSTGRES_PASSWORD'],
};

const REQUIRED = /\$\{TRACE_TARGET_[A-Z_]+:\?\}/u;
/** A secret is the run's value and nothing else; a URL may carry one inside it. */
const WHOLLY_REQUIRED = /^\$\{TRACE_TARGET_[A-Z_]+:\?\}$/u;

const sha256 = (file: string): string =>
  `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;

/** A service's environment as name to values; a name set twice keeps both. */
function settings(service: Service): Map<string, string[]> {
  const raw = service['environment'] ?? {};
  const pairs: [string, string][] = Array.isArray(raw)
    ? raw.map((entry) => {
        const text = String(entry);
        const at = text.indexOf('=');
        return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
      })
    : Object.entries(raw as Record<string, unknown>).map(([name, value]) => [name, String(value)]);
  const map = new Map<string, string[]>();
  for (const [name, value] of pairs) map.set(name, [...(map.get(name) ?? []), value]);
  return map;
}

function langfuseRefusals(name: string, service: Service): string[] {
  const env = settings(service);
  const refusals: string[] = [];
  const fixed = name === 'langfuse-web' ? { ...FIXED, AUTH_DISABLE_SIGNUP: 'true' } : FIXED;
  for (const [setting, value] of Object.entries(fixed)) {
    const values = env.get(setting) ?? [];
    if (values.length !== 1 || values[0] !== value) {
      refusals.push(`${name} ${setting} is not fixed to ${value}`);
    }
  }
  for (const [setting, values] of env) {
    if (ABSENT.test(setting)) refusals.push(`${name} ${setting} must be absent`);
    if (values.length > 1) refusals.push(`${name} ${setting} is set twice`);
  }
  return refusals;
}

function secretRefusals(name: string, service: Service): string[] {
  const env = settings(service);
  return (SECRETS[name] ?? [])
    .filter((setting) => {
      const values = env.get(setting) ?? [];
      const pattern = setting === 'DATABASE_URL' ? REQUIRED : WHOLLY_REQUIRED;
      return values.length !== 1 || !pattern.test(values[0] ?? '');
    })
    .map((setting) => `${name} ${setting} is not required from the run`);
}

/** Only the web port is published, and only on loopback. */
function portRefusals(name: string, service: Service): string[] {
  const ports = (service['ports'] ?? []) as unknown[];
  if (ports.length === 0) return [];
  const loopback = ports.every((port) => typeof port === 'string' && port.startsWith('127.0.0.1:'));
  return name === 'langfuse-web' && loopback
    ? []
    : [`${name} port is published off loopback or by a service that must publish none`];
}

function serviceRefusals(pin: Pin, name: string, service: Service): string[] {
  const refusals: string[] = [];
  const image = String(service['image'] ?? '');
  const tag = pin.version.replace(/^v/u, '');
  const langfuse = (LANGFUSE as readonly string[]).includes(name);
  if (image !== pin.services[name]) {
    refusals.push(`${name} image is not the pinned reference and digest`);
  }
  if (langfuse && !image.includes(`:${tag}@sha256:`)) {
    refusals.push(`${name} image is not the pinned version ${pin.version}`);
  }
  if (langfuse) refusals.push(...langfuseRefusals(name, service));
  refusals.push(...secretRefusals(name, service), ...portRefusals(name, service));
  if (name === 'redis') {
    const command = (service['command'] ?? []) as unknown[];
    const password = command[command.indexOf('--requirepass') + 1];
    if (!command.includes('--requirepass') || !REQUIRED.test(String(password))) {
      refusals.push('redis --requirepass is not required from the run');
    }
  }
  return refusals;
}

/** Every way the profile in `dir` drifts from its pin; empty when it holds. */
export function profileRefusals(dir: string): readonly string[] {
  const pin = JSON.parse(readFileSync(join(dir, 'pin.json'), 'utf8')) as Pin;
  const refusals: string[] = [];
  for (const [file, digest] of Object.entries(pin.vendor)) {
    if (sha256(join(dir, file)) !== digest)
      refusals.push(`${file} is not the vendor's file at the pin`);
  }
  const model = JSON.parse(readFileSync(join(dir, 'profile.resolved.json'), 'utf8')) as {
    services?: Record<string, Service>;
  };
  const services = model.services ?? {};
  const names = Object.keys(services).toSorted();
  if (names.join(',') !== Object.keys(pin.services).toSorted().join(',')) {
    refusals.push('the service set is not the six the pin names');
  }
  for (const name of names) {
    const service = services[name] ?? {};
    refusals.push(...(name in pin.services ? serviceRefusals(pin, name, service) : []));
  }
  return refusals;
}

const HERE = join(import.meta.dirname, 'trace-target');
const PROJECT = 'aw13-trace-target';
const ENV_FILE = join(import.meta.dirname, '..', '..', '.local', 'trace-target.env');

/** The model the vendor file and the override render to now, as `profile.resolved.json` holds it. */
function rendered(): unknown {
  const out = execFileSync(
    'docker',
    ['compose', '-p', PROJECT, '-f', 'docker-compose.yml', '-f', 'profile.override.yml'].concat([
      'config',
      '--no-interpolate',
      '--format',
      'json',
    ]),
    { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const model = JSON.parse(out) as Record<string, unknown>;
  return { networks: model['networks'], services: model['services'], volumes: model['volumes'] };
}

/** The profile as it stands, and the committed model against a fresh render. */
function checked(): void {
  const refusals = [...profileRefusals(HERE)];
  const committed = JSON.parse(
    readFileSync(join(HERE, 'profile.resolved.json'), 'utf8'),
  ) as unknown;
  if (!isDeepStrictEqual(rendered(), committed)) {
    refusals.push('profile.resolved.json is not what the vendor file and the override render to');
  }
  if (refusals.length > 0) {
    console.error(`trace-target: refused:\n  ${refusals.join('\n  ')}`);
    process.exit(1);
  }
  console.log('trace-target: the profile holds its pin');
}

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

/** A run's own secrets and first-start keys, in a file only its owner may read. */
function runSettings(port: number): string {
  const lines = [
    `TRACE_TARGET_PORT=${String(port)}`,
    ...['POSTGRES', 'CLICKHOUSE', 'MINIO', 'REDIS'].map(
      (store) => `TRACE_TARGET_${store}_PASSWORD=${hex(16)}`,
    ),
    `TRACE_TARGET_SALT=${hex(16)}`,
    `TRACE_TARGET_ENCRYPTION_KEY=${hex(32)}`,
    `TRACE_TARGET_NEXTAUTH_SECRET=${hex(32)}`,
    'LANGFUSE_INIT_ORG_ID=aw13-local',
    'LANGFUSE_INIT_ORG_NAME=aw13-local',
    'LANGFUSE_INIT_PROJECT_ID=aw13-local',
    'LANGFUSE_INIT_PROJECT_NAME=aw13-local',
    `LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-${hex(12)}`,
    `LANGFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-${hex(24)}`,
    'LANGFUSE_INIT_USER_EMAIL=operator@example.invalid',
    'LANGFUSE_INIT_USER_NAME=operator',
    `LANGFUSE_INIT_USER_PASSWORD=${hex(16)}`,
  ];
  mkdirSync(dirname(ENV_FILE), { recursive: true });
  writeFileSync(ENV_FILE, `${lines.join('\n')}\n`, { mode: 0o600 });
  return ENV_FILE;
}

function compose(...args: string[]): void {
  execFileSync(
    'docker',
    ['compose', '-p', PROJECT, '-f', 'profile.resolved.json', '--env-file', ENV_FILE, ...args],
    {
      cwd: HERE,
      stdio: 'inherit',
    },
  );
}

// `node scripts/local/trace-target.ts check | up <port> | down`: check the pin,
// start the disposable target on a loopback port with generated secrets
// (`.local/trace-target.env`), or destroy it with every volume and that file.
if (import.meta.main) {
  const [command, port] = process.argv.slice(2);
  checked();
  if (command === 'up') {
    runSettings(Number(port ?? 3910));
    compose('up', '--detach', '--wait', '--pull', 'never');
    console.log(`trace-target: up on http://127.0.0.1:${port ?? '3910'}, settings in ${ENV_FILE}`);
  } else if (command === 'down') {
    compose('down', '--volumes', '--remove-orphans');
    rmSync(ENV_FILE, { force: true });
    console.log('trace-target: destroyed, volumes and settings removed');
  } else if (command !== 'check') {
    console.error('trace-target: check | up <port> | down');
    process.exit(64);
  }
}
