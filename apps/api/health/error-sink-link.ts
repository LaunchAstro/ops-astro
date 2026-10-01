// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations view's link to the error sink (C55): the sink's web address,
// `OPS_ERROR_SINK_URL`, a setting that holds no secret. Never derived from
// `OPS_ERROR_SINK_DSN`, whose user part is the sink's key.

/** The link `operations.read` serves: the sink's address, or null with none set. */
export type ErrorSinkLink = { readonly url: string } | null;

/** The link from the settings. Not yet built: always null. */
export function errorSinkLink(
  _settings: Readonly<Record<string, string | undefined>>,
): ErrorSinkLink {
  return null;
}
