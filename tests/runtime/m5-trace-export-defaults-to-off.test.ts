// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';
import { traceExportSettings } from '../../apps/api/trace-exporter.ts';

const example = new URL('../../deploy/m5/trace-export.env.example', import.meta.url);

it('the M5 trace configuration leaves export off until the operator activates it', () => {
  const settings = parseEnv(readFileSync(example, 'utf8'));
  expect(settings['TRACE_EXPORT_ORIGIN']).toBe('http://127.0.0.1:3400');
  expect(traceExportSettings(settings)).toEqual({ kind: 'off' });
});

it('activating the M5 example without credential and identity files is refused', () => {
  const settings = parseEnv(readFileSync(example, 'utf8'));
  expect(settings['TRACE_EXPORT_CREDENTIALS_FILE']).toBe('');
  expect(settings['TRACE_EXPORT_KEY_FILE']).toBe('');
  expect(Object.keys(settings).toSorted()).toEqual([
    'TRACE_EXPORT',
    'TRACE_EXPORT_CREDENTIALS_FILE',
    'TRACE_EXPORT_KEY_FILE',
    'TRACE_EXPORT_ORIGIN',
  ]);
  expect(traceExportSettings({ ...settings, TRACE_EXPORT: 'on' })).toEqual({
    kind: 'invalid',
    problem: 'trace export is on but not set: TRACE_EXPORT_CREDENTIALS_FILE, TRACE_EXPORT_KEY_FILE',
  });
});
