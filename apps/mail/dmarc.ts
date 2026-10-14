// SPDX-License-Identifier: AGPL-3.0-only
//
// The mail unit's TXT reader for the sending root's DMARC record. The unit
// runs on the M5's internal network, where only the relay's names resolve, so
// a lookup may fail for want of a resolver, not of a record. DMARC is reported
// beside the three sending records and never required, so a lookup that
// fails reads as no record, and never stops a verified subdomain's mail.

/** `lookup`, answering no record where it fails. */
export function txtOrNone(
  lookup: (name: string) => Promise<string[][]>,
): (name: string) => Promise<string[][]> {
  return async (name) => {
    try {
      return await lookup(name);
    } catch {
      return [];
    }
  };
}
