# Verify a local foundation candidate

The aggregate suite tests the foundation tools. The candidate commands check
the actual files selected for publication. Neither is proof that a future
commit is signed or GitHub is enforcing its rules.

## Check the working copy

Use the Node major in `.nvmrc`, the package manager version in `package.json`,
Python 3.11 or newer, Git and Gitleaks. The Python minimum is required by the
standard-library TOML parser used for project configuration.

Run `corepack pnpm check` in the working checkout. Resolve failures. Stage
only the intended candidate files, including removals, without committing.
The export command refuses nonignored untracked files, staged ignored files,
conflicts, or differences between the selected index and working files.

```sh
git diff --cached --check
node scripts/public-content-check.mjs --repo "$PWD"
node scripts/candidate-snapshot.mjs export --repo "$PWD" --candidate ../foundation-candidate --manifest ../foundation-manifest.json
node scripts/candidate-snapshot.mjs check --candidate ../foundation-candidate --manifest ../foundation-manifest.json
node scripts/public-content-check.mjs --candidate ../foundation-candidate --manifest ../foundation-manifest.json
gitleaks dir ../foundation-candidate --redact --config .gitleaks.toml
```

Candidate and manifest destinations must be new, outside the working
repository, and have existing parent directories. The manifest is also
outside the candidate. Keep test logs and review reports outside the candidate.

The export contains selected file bytes and safe internal relative links. It
does not contain Git history or development dependencies. Its manifest hashes
the complete path/mode/content list. Rechecking the actual export detects
added, missing or changed files, changed modes and unsafe links. Changing
the manifest invalidates the recorded review identity.

The public-content guard supplements the existing contamination and secret
scanners. It uses hashed named exclusions, contextual rules and an exact-byte
exception for the inherited synthetic path canary. It does not recognise
every possible private name or paraphrase. Independently read the public
introduction, decisions and references before treating the content as cleared.

Pre-push and CI also scan commit metadata and every selected historical
blob/path pair, including removed files. A clean current tree cannot hide
private material in an earlier commit. An explicit committed range can be
checked with `node scripts/public-content-check.mjs --repo "$PWD" --range RANGE`.
First-root checks use the full ref. Shallow history and annotated tag targets
are refused rather than presented as complete history proof.

## Review and preserve evidence

Review the actual candidate and its manifest with a frontier model from a
different company than the builder's. Record the manifest identity, findings,
corrections and recheck. A local file review does not substitute for the
later Copilot, signing or hosted enforcement requirements. Do not certify inherited preparation history as the first
public root.

After the owner separately authorises a signed first-root commit, the clean
final repository can produce a commit-specific local receipt:

```sh
bash scripts/publication-receipt.sh --first-root --ref HEAD --output ../first-root-receipt.md
```

This requires exactly one root commit, a matching clean checkout, explicit
revision and new external output. It checks local signatures, provenance and
the proposed content/history. It does not verify GitHub signature display,
Copilot, rulesets, mailbox delivery or application behaviour.
