# Supply-chain pins, and where each one was verified

The tables retain pin identifiers and checks recorded on 6 September 2026.
They are historical reference evidence, not fresh upstream verification or a
security assessment of those dependencies.

`scripts/pins-check.mjs` compares workflow references with this record. A hash
fixes the selected bytes; it does not establish that those bytes are safe.
Update pins through a reviewed change and recheck the relevant publisher's
release when doing so.

## GitHub Actions

The prior record reports that these pins were resolved on **6 September 2026**
through the GitHub API, with annotated tags dereferenced and commits checked
in their source repositories. Reproduce that lookup when updating a pin:

```sh
gh api repos/<owner>/<repo>/releases/latest --jq .tag_name
gh api repos/<owner>/<repo>/git/ref/tags/<tag>          # object.sha
gh api repos/<owner>/<repo>/git/tags/<sha> --jq .object.sha   # annotated tags
gh api repos/<owner>/<repo>/commits/<sha>               # must return 200
```

| Action                              | Tag     | Commit                                     | Verified                               |
| ----------------------------------- | ------- | ------------------------------------------ | -------------------------------------- |
| `actions/checkout`                  | v7.0.1  | `3d3c42e5aac5ba805825da76410c181273ba90b1` | Tag ref, commit 200                    |
| `actions/setup-node`                | v7.0.0  | `820762786026740c76f36085b0efc47a31fe5020` | Tag ref, commit 200                    |
| `actions/upload-artifact`           | v7.0.1  | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | Tag ref, commit 200                    |
| `pnpm/action-setup`                 | v6.1.0  | `ea17c68df8912ef543352723c149a84f56e3d413` | Annotated tag dereferenced, commit 200 |
| `ossf/scorecard-action`             | v2.4.4  | `2d1146689b8cda280b9bc96326124645441f03bc` | Annotated tag dereferenced, commit 200 |
| `github/codeql-action/upload-sarif` | v4.37.9 | `cdf488f595d80d6e07e03d4674febd5ab45fa938` | Annotated tag dereferenced, commit 200 |

What that check does and does not establish. It establishes that the hash is
the commit the publisher's own release tag points at, so a later tag move
cannot change what runs here. It does not establish that the code at that
commit is trustworthy, and no automated check can. Raising a pin is a
reviewed change like any other dependency bump, and Renovate is configured to
propose them rather than merge them.

## Downloaded archives

| What                                  | Version | Digest                                                             | Verified                                                                                                                          |
| ------------------------------------- | ------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `gitleaks_<version>_linux_x64.tar.gz` | 8.30.1  | `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` | Published digest from the release's own `gitleaks_8.30.1_checksums.txt`, checked against a downloaded archive on 6 September 2026 |

The workflow downloads the archive to disk, checks it with `sha256sum -c`, and
only then extracts it. It used to pipe the download straight into `tar`, which
runs whatever arrives.

## Raising a pin

1. Resolve the new tag to its commit with the commands above.
2. Confirm the commit returns 200 in that repository.
3. Update the workflow **and this page** in the same commit.
4. For an archive, take the digest from the publisher's own checksums file and
   check it against a download before writing it here.

`scripts/pins-check.mjs` will fail the build if step 3 is forgotten, which is
the point of it.

## What is not pinned, and why

The npm dependency tree is pinned by `pnpm-lock.yaml`, which is committed, and
`pnpm install --frozen-lockfile` refuses to drift from it. Renovate proposes
updates; they merge like any other change, and never by Renovate itself. Like
any other change, an agent invokes that merge on Nathan's credential, because
his is the only account with push access, once every required check is green
on the head being merged, and it notifies him afterwards naming the pull
request and the merged revision. That notification records what happened; it
does not ask permission. The decisions
[Contributing](../CONTRIBUTING.md#who-invokes-the-merge) reserves to Nathan
are not reachable by a green check, and a reduction of any check's tier is one
of them, so no pin here is loosened by a dependency update merging.
