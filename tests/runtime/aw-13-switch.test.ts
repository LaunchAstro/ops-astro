// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13's configuration switch: export is off until one setting turns it on,
// a staged but malformed configuration stops the server with the setting's
// name and never its value, and the composition root's exporter sends a
// run's events through custody's egress to the target's trace path.

import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it as vitestIt } from 'vitest';
import {
  startTraceExporter,
  TRACE_PATH,
  traceExportSettings,
} from '../../apps/api/trace-exporter.ts';
import { derivedId } from '../../packages/core-runtime/src/index.ts';
import { liveWork, rows } from './schedules-harness.ts';
import { noDatabase, spanIds, t, useAw13World } from './aw-13-world.ts';

const folder = mkdtempSync(join(tmpdir(), 'aw13-switch-'));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const KEY_HEX = randomBytes(32).toString('hex');
const PUBLIC_KEY = `pk-lf-${randomBytes(8).toString('hex')}`;

function keyFile(name: string, text: string, mode = 0o600): string {
  const file = join(folder, name);
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
}

/** A private-looking name that links to another file. */
function linkTo(file: string): string {
  const link = join(folder, `link-${randomBytes(4).toString('hex')}`);
  symlinkSync(file, link);
  return link;
}

function staged(origin = 'http://127.0.0.1:9'): Record<string, string> {
  return {
    TRACE_EXPORT_ORIGIN: origin,
    TRACE_EXPORT_CREDENTIALS_FILE: join(folder, 'credentials.json'),
    TRACE_EXPORT_KEY_FILE: keyFile('key', KEY_HEX),
  };
}

/** Staged configurations that are each malformed in one way, the canary in the bad value. */
function malformed(canary: string): Record<string, string>[] {
  return [
    { ...staged(), TRACE_EXPORT: 'yes' },
    { ...staged(), TRACE_EXPORT: 'on', TRACE_EXPORT_ORIGIN: '' },
    { ...staged(), TRACE_EXPORT: 'on', TRACE_EXPORT_CREDENTIALS_FILE: '' },
    { ...staged(), TRACE_EXPORT: 'on', TRACE_EXPORT_KEY_FILE: '' },
    { ...staged(`http://127.0.0.1:9/${canary}`), TRACE_EXPORT: 'on' },
    { ...staged(`http://${canary}@127.0.0.1:9`), TRACE_EXPORT: 'on' },
    { ...staged(`file:///${canary}`), TRACE_EXPORT: 'on' },
    { ...staged(), TRACE_EXPORT: 'on', TRACE_EXPORT_KEY_FILE: keyFile('open', KEY_HEX, 0o644) },
    {
      ...staged(),
      TRACE_EXPORT: 'on',
      TRACE_EXPORT_KEY_FILE: keyFile('short', 'ab'.repeat(31)),
    },
    {
      ...staged(),
      TRACE_EXPORT: 'on',
      TRACE_EXPORT_KEY_FILE: keyFile('text', `${canary}`.repeat(4)),
    },
    { ...staged(), TRACE_EXPORT: 'on', TRACE_EXPORT_KEY_FILE: join(folder, canary) },
    {
      ...staged(),
      TRACE_EXPORT: 'on',
      TRACE_EXPORT_KEY_FILE: linkTo(keyFile('shared', KEY_HEX, 0o644)),
    },
  ];
}

describe('AW-13 off until one change', () => {
  vitestIt('with no setting, or everything staged but the switch, export is off', () => {
    expect(traceExportSettings({})).toEqual({ kind: 'off' });
    expect(traceExportSettings(staged())).toEqual({ kind: 'off' });
    expect(traceExportSettings({ ...staged(), TRACE_EXPORT: 'off' })).toEqual({ kind: 'off' });
  });

  vitestIt('the one change turns it on with the staged target and key', () => {
    const settings = traceExportSettings({ ...staged(), TRACE_EXPORT: 'on' });
    expect(settings).toMatchObject({
      kind: 'on',
      destination: { key: 'trace_target', origin: 'http://127.0.0.1:9' },
    });
    expect(settings.kind === 'on' && settings.key.equals(Buffer.from(KEY_HEX, 'hex'))).toBe(true);
  });

  vitestIt(
    'a malformed staged configuration is refused, naming the setting and never its value',
    () => {
      const canary = `canary${randomUUID().replaceAll('-', '')}`;
      const cases = malformed(canary);
      for (const environment of cases) {
        const settings = traceExportSettings(environment);
        expect(settings.kind, JSON.stringify(Object.keys(environment))).toBe('invalid');
        const problem = settings.kind === 'invalid' ? settings.problem : '';
        expect(problem).toMatch(/TRACE_EXPORT/u);
        expect(problem.includes(canary)).toBe(false);
        expect(problem.includes(folder)).toBe(false);
        expect(problem.includes(KEY_HEX)).toBe(false);
      }
    },
  );
});

/** Custody's credential file holding the target's key pair, as HTTP Basic. */
function pairFile(pair: string): string {
  const credentialsFile = join(folder, 'composed-credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'trace_key',
        kind: 'api_key',
        account: 'trace-target-1',
        destination: 'trace_target',
        header: 'authorization',
        scheme: 'basic',
        value: pair,
      },
    ]),
    { mode: 0o600 },
  );
  return credentialsFile;
}

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw13World('aw13_switch');

it('AW-13 composed exporter: once on, a run event reaches the target on its trace path through custody as HTTP Basic, under the configured key', async () => {
  const s = t.alpha;
  const credentialsFile = pairFile(`${PUBLIC_KEY}:${t.target.canary}`);
  const settings = traceExportSettings({
    TRACE_EXPORT: 'on',
    TRACE_EXPORT_ORIGIN: t.target.origin,
    TRACE_EXPORT_CREDENTIALS_FILE: credentialsFile,
    TRACE_EXPORT_KEY_FILE: keyFile('composed-key', KEY_HEX),
  });
  if (settings.kind !== 'on') throw new Error('the switch did not turn export on');
  const work = await liveWork(s, `aw13-switch-${randomUUID()}`, 1_000);
  const [event] = await rows<{ id: string }>(
    s,
    'select id from public.run_events where business_id = $1 and run_id = $2',
    [s.business, work.picked['runId']],
  );
  const expected = derivedId(
    Buffer.from(KEY_HEX, 'hex'),
    ['span', s.business, String(event?.id)],
    16,
  );
  const from = t.target.received.length;
  const exporter = await startTraceExporter(
    settings,
    t.alpha.db.app,
    () => Promise.resolve([s.business]),
    50,
  );
  try {
    const deadline = Date.now() + 20_000;
    while (!spanIds(t.target.received.slice(from)).includes(expected)) {
      if (Date.now() > deadline) throw new Error('the composed exporter sent nothing');
      // eslint-disable-next-line no-await-in-loop -- polling the stand-in target
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  } finally {
    await exporter.stop();
  }
  const basic = `Basic ${Buffer.from(`${PUBLIC_KEY}:${t.target.canary}`).toString('base64')}`;
  expect(new Set(t.target.paths.slice(from))).toEqual(new Set([TRACE_PATH]));
  expect(new Set(t.target.authorizations.slice(from))).toEqual(new Set([basic]));
  expect(t.target.received.slice(from).join('\n').includes(t.target.canary)).toBe(false);
});
