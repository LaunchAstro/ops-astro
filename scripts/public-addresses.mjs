// SPDX-License-Identifier: AGPL-3.0-only
// Contributor addresses, scoped by where the address sits.
//
// The naive rule is "no address anywhere", and it is the case this scope
// exists to avoid: every commit in this repository is authored by a GitHub
// no-reply identity, so a blanket rule fails the whole port range on its own
// provenance and teaches everyone to pass `--no-verify`. The distinction is
// real. An enumerated identity in a commit's author, committer or trailers is
// provenance Git put there. The same string inside a file or a path is
// published contact detail, which is what this policy is about.
// The final label must be alphabetic. Without that, an npm specifier such as
// a scoped package at a three-part version reads as an address and every
// lockfile in the repository becomes a finding.
//
// The local part is taken whole: every character a local part may carry
// (RFC 5322 atext, and dots), so punctuation at either edge of a listed local
// part makes a different, unlisted address, and is never dropped.
const addressPattern =
  /[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/giu;
// A match with an address character touching either end is part of a longer
// address, so no exact allowance applies to it.
const touchesBefore = /[@\p{L}\p{N}]$/u;
const touchesAfter = /^(?:[@\p{L}\p{N}_-]|\.[a-z0-9-])/iu;

/**
 * The address without what can be shown to frame it rather than belong to
 * it: a quote closed later on the same line, emphasis repeated right after
 * it, or the `//` of a URL's authority. Any other edge character stays.
 */
function framed(text, index, address) {
  const end = index + address.length;
  const lineEnd = text.indexOf('\n', end);
  const after = text.slice(end, lineEnd === -1 ? undefined : lineEnd);
  const quote = /^['`]/u.exec(address)?.[0];
  if (quote !== undefined && after.includes(quote)) return address.slice(1);
  const emphasis = /^(?:\*\*?|__?)/u.exec(address)?.[0];
  if (emphasis !== undefined && after.startsWith(emphasis)) return address.slice(emphasis.length);
  if (address.startsWith('//') && text[index - 1] === ':') return address.slice(2);
  return address;
}

// Provenance only. Allowed as a commit identity; a finding inside a blob.
const provenanceIdentities = [
  /^(?:\d+\+)?[a-z0-9-]+@users\.noreply\.github\.com$/u,
  /^noreply@github\.com$/u,
];

// Deliberately published, so allowed wherever they appear: the public
// security address this project documents, and the reserved documentation
// domains of RFC 2606 and RFC 6761, which can never reach a mailbox.
//
// The last six are the local slice's five synthetic logins and the staging
// reset's made-up operator, one entry each and no wildcard: docs/local/README.md
// lists them as the whole set, and a seventh invented one should be a finding
// until that file and this list both say so.
// `.local` is reserved for multicast DNS by RFC 6762 and is not delegable, so
// these cannot reach a mailbox either, and a real address at someone's Bonjour
// hostname is still a finding because it is not one of these six.
// Then Sol's REVB1SL01S34 proof (byte for byte): two made-up database logins,
// password `example` before a host, which read as addresses; those strings alone.
const publishedAddresses = [
  /^security@launchastro\.com$/u,
  /^[^@]+@example\.(?:invalid|test|localhost)$/u,
  // owner@ is the synthetic pooler login Sol's staging-logins proof names (ORCH76 D1ALLOW).
  /^(?:example@(?:production-db\.example\.test|aws-0-ap-southeast-2\.pooler\.supabase\.com)|owner@aws-0-ap-southeast-2\.pooler\.supabase\.com)$/u,
  /^[^@]+@example\.(?:com|net|org)$/u,
  /^ada@alpha\.local$/u,
  /^mia@alpha\.local$/u,
  /^noah@alpha\.local$/u,
  /^orphan@alpha\.local$/u,
  /^bea@bravo\.local$/u,
  /^olive@alpha\.local$/u,
];

export function addressRules(text, scope) {
  const found = new Set();
  for (const { 0: address, index } of text.matchAll(addressPattern)) {
    // A file name has no quotes or emphasis to frame an address: it is read whole.
    const value = (scope === 'path' ? address : framed(text, index, address)).toLowerCase();
    const local = value.slice(0, value.lastIndexOf('@'));
    // Not a written address: no letter or digit in the local part (a bare
    // `'@host'`), or a local part a `${...}` placeholder ends, which code
    // fills in when it runs.
    if (!/[\p{L}\p{N}]/u.test(local) || /\$\{[^}]*\}$/u.test(local)) continue;
    const end = index + address.length;
    const whole =
      !touchesBefore.test(text.slice(Math.max(0, index - 2), index)) &&
      !touchesAfter.test(text.slice(end, end + 2));
    if (whole && publishedAddresses.some((allowed) => allowed.test(value))) continue;
    if (scope === 'commit') {
      if (whole && provenanceIdentities.some((allowed) => allowed.test(value))) continue;
      found.add('unlisted-commit-identity');
      continue;
    }
    found.add('contributor-address');
  }
  return [...found];
}
