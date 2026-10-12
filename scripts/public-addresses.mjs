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
const addressPattern = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/giu;

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
  /^[a-z0-9._%+-]+@example\.(?:invalid|test|localhost)$/u,
  // owner@ is the synthetic pooler login Sol's staging-logins proof names (ORCH76 D1ALLOW).
  /^(?:example@(?:production-db\.example\.test|aws-0-ap-southeast-2\.pooler\.supabase\.com)|owner@aws-0-ap-southeast-2\.pooler\.supabase\.com)$/u,
  /^[a-z0-9._%+-]+@example\.(?:com|net|org)$/u,
  /^ada@alpha\.local$/u,
  /^mia@alpha\.local$/u,
  /^noah@alpha\.local$/u,
  /^orphan@alpha\.local$/u,
  /^bea@bravo\.local$/u,
  /^olive@alpha\.local$/u,
];

export function addressRules(text, scope) {
  const found = new Set();
  for (const [address] of text.matchAll(addressPattern)) {
    const value = address.toLowerCase();
    if (publishedAddresses.some((allowed) => allowed.test(value))) continue;
    if (scope === 'commit') {
      if (provenanceIdentities.some((allowed) => allowed.test(value))) continue;
      found.add('unlisted-commit-identity');
      continue;
    }
    found.add('contributor-address');
  }
  return [...found];
}
