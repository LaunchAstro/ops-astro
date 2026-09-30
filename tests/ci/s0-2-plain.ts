// SPDX-License-Identifier: AGPL-3.0-only
// Shared by the S0-2 cases. What a reader must never find in an alert or a
// monitor's name (ticket S0-2): a setting, a secret or an identifier. In
// order: a digit (record identifiers, ports, addresses, counts that read like
// ids), an address, an email address or a DSN's key, a setting's name, and
// an em dash, which plain words do without.
export const NOT_PLAIN: readonly RegExp[] = [
  /[0-9]/u,
  /https?:|www\.|\.com|\.au/iu,
  /@/u,
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/u,
  /—/u,
];

/** Run `step` `count` times, one after another: the detector counts a sequence. */
export async function times(count: number, step: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    // oxlint-disable-next-line no-await-in-loop
    await step();
  }
}
