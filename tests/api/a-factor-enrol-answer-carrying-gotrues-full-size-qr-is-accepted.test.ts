// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: GoTrue v2.197.0 answers an authenticator enrol with its QR as raw SVG
// (`mfa.go`, `QRCode: buf.String()`, drawn by SVGo a square per module) of
// about 320,000 characters, a body of about 410 KB. The enrol is read to that
// size and no further, its QR admitted only as SVG and handed on as the SVG
// data URI the browser draws; every other call keeps its own smaller bound.
// No request leaves the test process.
import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { gotrueQrSvg } from './gotrue-qr-svg.ts';

const BASE = 'http://identity.invalid/auth/v1';
const SECRET = 'JBSWY3DPEHPK3PXP';
const URI = 'otpauth://totp/x?secret=S';

/** The browser's form of a raw SVG: what the adapter hands on. */
const asDataUri = (svg: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;

function enrolAnswer(qrCode: unknown, extra: Readonly<Record<string, unknown>> = {}) {
  return {
    id: 'factor-one',
    type: 'totp',
    friendly_name: '',
    totp: { qr_code: qrCode, secret: SECRET, uri: URI },
    ...extra,
  };
}

/** JSON as Go's `encoding/json` writes it, which GoTrue answers in: `<`, `>` and `&` escaped. */
const goJson = (body: unknown): string =>
  JSON.stringify(body)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');

/** The answer streamed in 16 KiB chunks with no content-length, as a chunked answer comes. */
function streamed(body: unknown): Response {
  const bytes = new TextEncoder().encode(goJson(body));
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + 16_384));
      at += 16_384;
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

function answering(body: unknown) {
  const fetch: typeof globalThis.fetch = () => Promise.resolve(streamed(body));
  return createGoTrueFactors({ baseUrl: BASE, fetch });
}

it("C59: an enrol answer carrying GoTrue's full-size raw SVG QR is accepted and handed on as an image", async () => {
  const svg = gotrueQrSvg(330_000);
  const body = enrolAnswer(svg);
  expect(svg).toHaveLength(330_000);
  // GoTrue's measured answer: 321,600 characters of QR in 410,701 bytes.
  expect(goJson(body).length).toBeGreaterThan(410_000);
  const answer = await answering(body).enrol('person-token');
  expect(answer).toEqual({
    ok: true,
    value: { factorId: 'factor-one', qrCode: asDataUri(svg), secret: SECRET, uri: URI },
  });
  // The browser draws only an SVG data URI, and this one decodes to GoTrue's own SVG.
  const qr = answer.ok ? answer.value.qrCode : '';
  expect(qr.startsWith('data:image/svg+xml')).toBe(true);
  expect(Buffer.from(qr.split(',')[1] ?? '', 'base64').toString('utf8')).toBe(svg);
});

it('C59: a bare <svg> with no XML declaration is SVG too', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>\n';
  const answer = await answering(enrolAnswer(svg)).enrol('t');
  expect(answer.ok && answer.value.qrCode).toBe(asDataUri(svg));
});

it('C59: a QR that is not SVG is refused, and the factor the provider issued is named', async () => {
  for (const qrCode of [
    'https://elsewhere.invalid/qr.svg',
    'data:text/html,<script>alert(1)</script>',
    'data:image/svg+xml;utf-8,<svg/>',
    'javascript:alert(1)',
    '<html><svg></svg></html>',
    '<svgx></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect/>',
    '',
    42,
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one hostile answer after another
    expect(await answering(enrolAnswer(qrCode)).enrol('t')).toEqual({
      ok: false,
      fault: 'malformed',
      strayFactorId: 'factor-one',
    });
  }
});

it('C59: a QR past a megabyte of characters is refused', async () => {
  expect(await answering(enrolAnswer(gotrueQrSvg(1_048_577))).enrol('t')).toEqual({
    ok: false,
    fault: 'malformed',
    strayFactorId: 'factor-one',
  });
  const atLimit = await answering(enrolAnswer(gotrueQrSvg(1_048_576))).enrol('t');
  expect(atLimit.ok).toBe(true);
});

it('C59: an otherwise good enrol answer past its read bound is abandoned as oversized', async () => {
  const body = enrolAnswer(gotrueQrSvg(330_000), { padding: 'x'.repeat(2 * 1024 * 1024) });
  expect(await answering(body).enrol('t')).toEqual({ ok: false, fault: 'oversized' });
});

it('C59: an answer whose factor id is not an identifier names no stray', async () => {
  expect(await answering({ ...enrolAnswer(gotrueQrSvg(1000)), id: '../admin' }).enrol('t')).toEqual(
    { ok: false, fault: 'malformed' },
  );
});

it('C59: the secret and uri keep their limits beside a full-size QR', async () => {
  const qrCode = gotrueQrSvg(330_000);
  for (const totp of [
    { qr_code: qrCode, secret: 'S'.repeat(129), uri: URI },
    { qr_code: qrCode, secret: 'S', uri: `otpauth://totp/${'x'.repeat(1024)}` },
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one hostile answer after another
    expect(await answering({ id: 'factor-one', totp }).enrol('t')).toEqual({
      ok: false,
      fault: 'malformed',
      strayFactorId: 'factor-one',
    });
  }
});

it("C59: only the enrol reads a large answer; a verify's stays at its own bound", async () => {
  const fetch: typeof globalThis.fetch = (input) =>
    Promise.resolve(
      String(input).endsWith('/challenge')
        ? Response.json({ id: 'challenge-one' })
        : streamed({
            access_token: 'a',
            refresh_token: 'r',
            expires_in: 3600,
            padding: 'x'.repeat(40_000),
          }),
    );
  const provider = createGoTrueFactors({ baseUrl: BASE, fetch });
  expect(await provider.verify('t', 'factor-one', '123456')).toEqual({
    ok: false,
    fault: 'oversized',
  });
});
