// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13 pinned profile: the local trace target is the vendor's compose file and
// environment example at v4.33.0, byte-identical, with the checked override on
// top, rendered into the model that runs. A version, digest, service set or
// environment that drifts from the pin is refused, each by name. No image is
// pulled and nothing starts: this reads the files a run would use.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { profileRefusals } from '../../scripts/local/trace-target.ts';

const PROFILE = resolve(import.meta.dirname, '../../scripts/local/trace-target');
const copies: string[] = [];

afterAll(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});

interface Model {
  services: Record<string, Record<string, unknown>>;
}

/** A copy of the profile with one change made to it. */
function drifted(change: (dir: string, model: Model) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw13-profile-'));
  copies.push(dir);
  cpSync(PROFILE, dir, { recursive: true });
  const file = join(dir, 'profile.resolved.json');
  const model = JSON.parse(readFileSync(file, 'utf8')) as Model;
  change(dir, model);
  writeFileSync(file, JSON.stringify(model));
  return dir;
}

const environment = (model: Model, service: string): string[] =>
  model.services[service]?.['environment'] as string[];

const setting = (model: Model, service: string, name: string, value: string): void => {
  const list = environment(model, service).filter((entry) => !entry.startsWith(`${name}=`));
  model.services[service] = {
    ...model.services[service],
    environment: [...list, `${name}=${value}`],
  };
};

it('AW-13 pinned profile: the checked profile holds its pin', () => {
  expect(profileRefusals(PROFILE)).toEqual([]);
});

const web = 'langfuse-web';
const worker = 'langfuse-worker';
/** Each drift: its name, the refusal that names it, and the change. */
const DRIFTS: [string, RegExp, (dir: string, model: Model) => void][] = [
  [
    'vendor compose, one byte',
    /docker-compose\.yml/u,
    (dir) => {
      const file = join(dir, 'docker-compose.yml');
      writeFileSync(file, `${readFileSync(file, 'utf8')} `);
    },
  ],
  [
    'the pin names another version',
    /version/u,
    (dir) => {
      const file = join(dir, 'pin.json');
      writeFileSync(file, readFileSync(file, 'utf8').replace('"v4.33.0"', '"v4.34.0"'));
    },
  ],
  [
    'an image by tag alone',
    /langfuse-web image/u,
    (_dir, model) => {
      model.services[web] = {
        ...model.services[web],
        image: 'docker.io/langfuse/langfuse:4.33.0',
      };
    },
  ],
  [
    'another digest',
    /postgres image/u,
    (_dir, model) => {
      model.services['postgres'] = {
        ...model.services['postgres'],
        image: `docker.io/postgres:17@sha256:${'0'.repeat(64)}`,
      };
    },
  ],
  [
    "the vendor's own registry",
    /langfuse-worker image/u,
    (_dir, model) => {
      const image = String(model.services[worker]?.['image']);
      model.services[worker] = {
        ...model.services[worker],
        image: image.replace('docker.io', 'docker.langfuse.com'),
      };
    },
  ],
  [
    'a seventh service',
    /service set/u,
    (_dir, model) => {
      model.services['extra'] = { image: 'docker.io/busybox:1' };
    },
  ],
  [
    'a service missing',
    /service set/u,
    (_dir, model) => {
      delete model.services['minio'];
    },
  ],
  [
    'telemetry on',
    /langfuse-worker TELEMETRY_ENABLED/u,
    (_dir, model) => {
      setting(model, worker, 'TELEMETRY_ENABLED', 'true');
    },
  ],
  [
    'telemetry unset',
    /langfuse-web TELEMETRY_ENABLED/u,
    (_dir, model) => {
      model.services[web] = {
        ...model.services[web],
        environment: environment(model, web).filter(
          (entry) => !entry.startsWith('TELEMETRY_ENABLED='),
        ),
      };
    },
  ],
  [
    'a licence key',
    /langfuse-web LANGFUSE_EE_LICENSE_KEY/u,
    (_dir, model) => {
      setting(model, web, 'LANGFUSE_EE_LICENSE_KEY', 'x');
    },
  ],
  [
    'media upload back',
    /langfuse-worker LANGFUSE_S3_MEDIA_UPLOAD_BUCKET/u,
    (_dir, model) => {
      setting(model, worker, 'LANGFUSE_S3_MEDIA_UPLOAD_BUCKET', 'langfuse');
    },
  ],
  [
    'an SSRF allowlist',
    /langfuse-web LANGFUSE_LLM_CONNECTION_WHITELISTED_IPS/u,
    (_dir, model) => {
      setting(model, web, 'LANGFUSE_LLM_CONNECTION_WHITELISTED_IPS', '10.0.0.1');
    },
  ],
  [
    'signup open',
    /langfuse-web AUTH_DISABLE_SIGNUP/u,
    (_dir, model) => {
      setting(model, web, 'AUTH_DISABLE_SIGNUP', 'false');
    },
  ],
  [
    'a secret with a default',
    /langfuse-worker SALT/u,
    (_dir, model) => {
      setting(model, worker, 'SALT', '${SALT:-mysalt}');
    },
  ],
  [
    'a setting twice',
    /langfuse-web LANGFUSE_S3_EVENT_UPLOAD_BUCKET is set twice/u,
    (_dir, model) => {
      const list = environment(model, web);
      model.services[web] = {
        ...model.services[web],
        environment: [...list, 'LANGFUSE_S3_EVENT_UPLOAD_BUCKET=elsewhere'],
      };
    },
  ],
  [
    'a secret with a fixed prefix',
    /langfuse-web SALT/u,
    (_dir, model) => {
      setting(model, web, 'SALT', 'mysalt${TRACE_TARGET_SALT:?}');
    },
  ],
  [
    'the cache without its password',
    /redis --requirepass/u,
    (_dir, model) => {
      model.services['redis'] = {
        ...model.services['redis'],
        command: ['--maxmemory-policy', 'noeviction'],
      };
    },
  ],
  [
    'the blob store published, even on loopback',
    /minio port/u,
    (_dir, model) => {
      model.services['minio'] = { ...model.services['minio'], ports: ['127.0.0.1:9090:9000'] };
    },
  ],
  [
    'the blob store published on every interface',
    /minio port/u,
    (_dir, model) => {
      model.services['minio'] = { ...model.services['minio'], ports: ['9090:9000'] };
    },
  ],
  [
    'the web port on every interface',
    /langfuse-web port/u,
    (_dir, model) => {
      model.services[web] = { ...model.services[web], ports: ['3000:3000'] };
    },
  ],
  [
    'a store password with a default',
    /postgres POSTGRES_PASSWORD/u,
    (_dir, model) => {
      model.services['postgres'] = {
        ...model.services['postgres'],
        environment: {
          ...(model.services['postgres']?.['environment'] as object),
          POSTGRES_PASSWORD: 'postgres',
        },
      };
    },
  ],
];

it('AW-13 pinned profile: a version, digest, service set or environment that drifts is refused by name', () => {
  for (const [name, reason, change] of DRIFTS) {
    const refusals = profileRefusals(drifted(change));
    expect(refusals.join('\n'), name).toMatch(reason);
  }
});
