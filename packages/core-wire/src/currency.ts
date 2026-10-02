// SPDX-License-Identifier: AGPL-3.0-only
//
// A currency's minor digits, from one fixed table: the ISO 4217 minor-unit
// exponents. The server counts money by them (the four-eyes band, a top-up)
// and the browser draws and parses money by them, so both read this table and
// neither reads its own Intl data, which differs between Node and browsers
// (Node gives IDR 0 digits, ISO 4217 gives 2). A code missing here has 2.

/** ISO 4217's currencies whose minor unit is not 2 digits. */
const NOT_TWO: ReadonlyMap<string, number> = new Map([
  ...['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF'].map(
    (code) => [code, 0] as const,
  ),
  ...['UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'].map((code) => [code, 0] as const),
  ...['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'].map((code) => [code, 3] as const),
  ...['CLF', 'UYW'].map((code) => [code, 4] as const),
]);

/** The currency's minor digits: 2 for AUD, 0 for JPY, 3 for KWD. */
export function minorDigits(currency: string): number {
  return NOT_TWO.get(currency) ?? 2;
}
