// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { checkEnvelope } from '../../packages/core-connectors/src/site/envelope.ts';

it('an empty fragment cannot make a character reference body copy', async () => {
  const path = 'src/pages/index.astro';
  const before = '<p>Fish &{""}<></>amp; chips</p>\n';
  const target = { path, word: 'amp', replacement: 'copy' };
  const after = before.replace('amp', 'copy');
  expect(await checkEnvelope({ files: [{ path, before, after }] }, target)).toMatchObject({
    ok: false,
    code: 'CHANGE_ENVELOPE_EXCEEDED',
  });
});
