// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations view's link to the error sink (C55): the sink's web address,
// `OPS_ERROR_SINK_URL`, a setting that holds no secret. Never derived from
// `OPS_ERROR_SINK_DSN`, whose user part is the sink's key: an address with a
// user part, which is what a DSN pasted here would be, stops the start, and
// the problem names the setting, never its value.

/** The link `operations.read` serves: the sink's address, or null with none set. */
export type ErrorSinkLink = { readonly url: string } | null;

const PROBLEM =
  'OPS_ERROR_SINK_URL is not an https address without a user part (the sink’s web address, never its DSN).';

/** The link from the settings; throws, naming the setting only, on an address it refuses. */
export function errorSinkLink(
  settings: Readonly<Record<string, string | undefined>>,
): ErrorSinkLink {
  const value = settings['OPS_ERROR_SINK_URL'] ?? '';
  if (value === '') return null;
  let address: URL;
  try {
    address = new URL(value);
  } catch {
    throw new Error(PROBLEM);
  }
  if (address.protocol !== 'https:' || address.username !== '' || address.password !== '') {
    throw new Error(PROBLEM);
  }
  return { url: address.href };
}
