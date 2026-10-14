// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// C59: the stand-in for GoTrue's raw SVG QR is itself a drawable SVG at every
// length the suites ask of it, so a QR accepted at a boundary is one the
// browser can draw, not text that only looks like SVG at its two ends.
import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { gotrueQrSvg } from './gotrue-qr-svg.ts';

/** The parser's complaint about `svg` as the browser reads an SVG image, or null. */
function parseError(svg: string): string | null {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  return parsed.querySelector('parsererror')?.textContent ?? null;
}

it('C59: the GoTrue QR stand-in parses as SVG at every length the suites use', () => {
  for (const [characters, mark] of [
    [2000, ''],
    [330_000, ''],
    [330_000, 'person-a'],
    [1_048_576, ''],
  ] as const) {
    const svg = gotrueQrSvg(characters, mark);
    expect(svg).toHaveLength(characters);
    expect(parseError(svg)).toBeNull();
  }
});

it('C59: the QR accepted at the megabyte boundary decodes to an SVG the browser can draw', async () => {
  const svg = gotrueQrSvg(1_048_576);
  const provider = createGoTrueFactors({
    baseUrl: 'http://identity.invalid/auth/v1',
    fetch: () =>
      Promise.resolve(
        Response.json({
          id: 'factor-one',
          totp: { qr_code: svg, secret: 'S', uri: 'otpauth://totp/x' },
        }),
      ),
  });
  const answer = await provider.enrol('person-token');
  if (!answer.ok) throw new Error(`the enrol was refused: ${answer.fault}`);
  const drawn = Buffer.from(answer.value.qrCode.split(',')[1] ?? '', 'base64').toString('utf8');
  expect(drawn).toBe(svg);
  expect(parseError(drawn)).toBeNull();
});
