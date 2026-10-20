// SPDX-License-Identifier: AGPL-3.0-only
//
// The M5's pinned Langfuse setup (#1622, deploy/m5/langfuse.md): the pins
// file the owner adds as the last Compose file changes only images and the
// signup, media upload and telemetry settings, for services the installed
// vendor file declares; its LaunchAgent runs the boot script once at load and
// holds no setting's value. Nothing here starts a container.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

interface Service {
  readonly image?: string;
  readonly environment?: Record<string, string>;
}

const pins = (
  parse(read('deploy/m5/langfuse-pins.override.yml')) as {
    services: Record<string, Service>;
  }
).services;

describe('the M5 Langfuse pins', () => {
  it('keep signup and media upload off and telemetry off on the web and the worker', () => {
    expect(pins['langfuse-web']?.environment).toEqual({
      AUTH_DISABLE_SIGNUP: 'true',
      LANGFUSE_MEDIA_UPLOAD_ENABLED: 'false',
      TELEMETRY_ENABLED: 'false',
    });
    expect(pins['langfuse-worker']?.environment).toEqual({
      LANGFUSE_MEDIA_UPLOAD_ENABLED: 'false',
      TELEMETRY_ENABLED: 'false',
    });
  });

  it('change only images and those settings, so ports, volumes and restart stay the installation’s', () => {
    for (const [name, service] of Object.entries(pins)) {
      const allowed = name.startsWith('langfuse-') ? ['environment', 'image'] : ['image'];
      expect(Object.keys(service).toSorted(), name).toEqual(allowed);
    }
  });

  it('name only services of the vendor file the M5 installed, byte for byte', () => {
    const vendor = read('scripts/local/trace-target/docker-compose.yml');
    // The installed base file's digest, recorded in deploy/m5/langfuse.md.
    expect(createHash('sha256').update(vendor).digest('hex')).toBe(
      'd373385b2ad54d11c4d26a66c70ee7eaab87c7088adeb6a017c6612143efc697',
    );
    const declared = Object.keys((parse(vendor) as { services: object }).services).toSorted();
    expect(Object.keys(pins).toSorted()).toEqual(declared);
  });
});

describe('the M5 Langfuse LaunchAgent', () => {
  const plist = (): string => read('deploy/m5/ops-astro-langfuse.plist');

  it('runs the boot script once at load, never kept alive', () => {
    expect(plist()).toContain('<string>scripts/m5/langfuse-up.sh</string>');
    expect(plist()).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/u);
    expect(plist()).not.toContain('<key>KeepAlive</key>');
  });

  it('names the installation and repository folders and holds no setting’s value', () => {
    expect(plist()).toContain('<key>LANGFUSE_INSTALL_DIR</key>');
    expect(plist()).toContain('<key>LANGFUSE_REPO_DIR</key>');
    expect(plist()).not.toMatch(/SECRET|PASSWORD|SALT|ENCRYPTION_KEY|sk-lf-|pk-lf-/u);
  });
});
