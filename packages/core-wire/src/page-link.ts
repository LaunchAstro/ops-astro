// SPDX-License-Identifier: AGPL-3.0-only
//
// What a task's page link may hold (MP-4-12, CS-4.22): an address inside the
// product, its path and hash, never a door out of it.
//
// One rule for the server, which refuses anything else before it is stored,
// and for the web, which draws a stored value that fails it as words rather
// than as a link. The rule is a shape, not a list of bad schemes: the value
// starts with one `/` and the next character is not another `/` or a
// backslash (both of which a browser reads as another host), and it holds no
// backslash, whitespace or control character anywhere (the address parser
// drops a tab or a line break, so `/\t/host` is `//host`).

/** The longest address kept. */
export const PAGE_LINK_LIMIT = 2048;

// oxlint-disable-next-line no-control-regex -- the control characters are what it looks for
const UNSAFE = /[\\\s\u0000-\u001F\u007F]/u;

export function isInProductLink(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= PAGE_LINK_LIMIT &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !UNSAFE.test(value)
  );
}
