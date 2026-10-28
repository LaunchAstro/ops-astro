// SPDX-License-Identifier: AGPL-3.0-only
//
// The QR of an authenticator enrol (C59), as the provider sends it and as the
// browser draws it. GoTrue sends raw SVG (`mfa.go`, `buf.String()`), v2.192.0
// and v2.197.0 alike, a square per module, light ones included: about 320,000
// characters. It is admitted to a megabyte of characters, only as SVG, and
// handed on as the SVG data URI the browser draws as an image, never as markup.

import { Buffer } from 'node:buffer';

const QR_MAX_CHARACTERS = 1024 * 1024;

// SVG as SVGo writes it: an XML declaration and a comment, either optional,
// then the `svg` element, closed at the end.
const SVG_OPENING = /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[^>]*-->\s*)?<svg[\s>]/u;

/** The QR as an SVG data URI, or `undefined` for anything but bounded SVG. */
export function qrImage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > QR_MAX_CHARACTERS) return undefined;
  if (!SVG_OPENING.test(value) || !value.trimEnd().endsWith('</svg>')) return undefined;
  return `data:image/svg+xml;base64,${Buffer.from(value, 'utf8').toString('base64')}`;
}
