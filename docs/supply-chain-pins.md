# Supply-chain pins, and where each one was verified

The tables retain pin identifiers and checks recorded on 6 September 2026.
They are historical reference evidence, not fresh upstream verification or a
security assessment of those dependencies.

`scripts/pins-check.mjs` compares workflow references with this record. A hash
fixes the selected bytes; it does not establish that those bytes are safe.
Update pins through a reviewed change and recheck the relevant publisher's
release when doing so.

## GitHub Actions

The prior record reports that these pins were resolved on 6 September 2026
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

That check establishes that the hash is the commit the publisher's own release
tag points at, so a later tag move cannot change what runs here. It does not establish that the code at that
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

## Container images

A service container runs code inside the job exactly as an action does, so it
is pinned the same way. `scripts/pins-check.mjs` refuses an `image:`, a
`container:` or a `uses: docker://` step that is not a sha256 digest, refuses
an image written as a `${{ }}` expression, since that picks the image at run
time, and refuses a digest that is not recorded here. A bare `container:`
opens a mapping, and its own `image:` line is held to the same rule.

The check is not a YAML parser. It reads each workflow line by line, with LF,
CRLF or CR line endings. It reads a `uses`, `image` or `container` key written
plain or quoted, with or without space before its colon, and with its value
on the same line or the next. It refuses a line where such a key follows a `{`
or `[`, with or without a space after the bracket, and any line that begins
with an explicit `? ` key, after an optional `- `. A bracket or a `#` inside a
quoted scalar is text, and a `#` is a comment only after a space, so
`name: "#"` or `name: step#1` before the key does not hide it; a doubled `''`
inside single quotes is text too. A comment line is never refused.

Other key forms are not guaranteed to be read: a tagged key (`!!str uses:`),
an escaped quoted key, and a key inside a flow collection, or a quoted scalar,
that spans lines. Write each of these keys in block style, one per line. The
flow scan does not know block scalars either, so a `run: |` line holding an
unquoted `{` or `[` followed by a `uses:`, `image:` or `container:` string can
be refused. That is a false red, not a pin getting through: quote the shell
text or move it to a script.
Parsing the workflows as YAML is a recorded follow-up.
`tests/ci/pins-check-cases.sh` holds the cases.

The check holds every `*IMAGE=` line in `scripts/local/*.sh` to the same
digest and record (`CQ-3 auth image pin`); an image named inline is not read.

| Image                            | Tag         | Digest                                                                    | Verified                                                                                                                                                                                                                                                                       |
| -------------------------------- | ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node`                           | `24-alpine` | `sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1` | The staging worker and its outbox forwarder, `deploy/staging/compose.json` (S0-1, S0-2). The tag's index digest, read with `docker buildx imagetools inspect` on 30 September 2026                                                                                             |
| `postgres`                       | `18-alpine` | `sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873` | CI's look-ahead job only (S0-7). Resolved from the tag with `docker pull postgres:18-alpine` on 23 September 2026 and read back from `docker image inspect --format '{{index .RepoDigests 0}}'`                                                                                |
| `postgres`                       | `17-alpine` | `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24` | Production's major (LF-3): staging's backup store, `deploy/staging/compose.json`; CI's required database jobs; `scripts/local/db-up.sh`, `restart-proof.sh` and `auth-up.sh` (S0-7). The tag's index digest, read with `docker buildx imagetools inspect` on 29 September 2026 |
| `public.ecr.aws/supabase/gotrue` | `v2.192.0`  | `sha256:b252efb680be37d4a8bf77c210cf0439c19b63a4b51929233a65dd101d25bdab` | The local slice's GoTrue, `scripts/local/auth-up.sh`. The tag's index digest, read with `docker buildx imagetools inspect` on 28 September 2026 and matching `docker image inspect --format '{{json .RepoDigests}}'` of the pulled tag                                         |
| `semgrep/semgrep`                | `1.177.0`   | `sha256:acaac22ffc7b7cc5926de0751b223bce0b2491c33d18422fa72f632c78d81198` | CI's Semgrep check of the two settings files, `scripts/local/semgrep-settings.sh`. The tag's index digest, read with `docker buildx imagetools inspect` on 28 September 2026                                                                                                   |

Reproduce it the same way when raising the pin:

```sh
docker pull postgres:<tag>
docker image inspect postgres:<tag> --format '{{index .RepoDigests 0}}'
```

The hosted database runs Postgres 17, so everything that stands in for it runs
the 17 digest: staging, the required `database conformance` and `isolation
tests` jobs, the local database, the restart proof and the local auth stack.
`tests/ci/s0-7-postgres-major.test.ts` fails if any of them differs, and a
planted migration calling `uuidv7()`, which only 18 has, fails the required
job. The `database look-ahead, Postgres 18 (not required)` job runs the same
conformance suites on the 18 digest on every pull request; its failure is
reported and blocks nothing. When the provider offers Postgres 18, one ticket
moves production, staging, CI and the restore drill (S0-3) to it together.

As with an action hash, this establishes which bytes run and nothing about
whether those bytes are trustworthy. The database conformance job gives that
container a throwaway password of its own and no repository secret.

## npm pins that a check depends on

Every npm dependency is pinned by `pnpm-lock.yaml`. These are recorded here as
well, because a check's behaviour depends on the exact version and a reader
comparing this page with the lockfile should find them agreeing.

| Package              | Version | Why the version matters                                                                                                   |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `dependency-cruiser` | 18.4.0  | The structural dependency check. Its own TypeScript path supports `typescript >=2.0.0 <7.0.0`.                            |
| `typescript`         | 7.0.2   | Ahead of that range, so dependency-cruiser cannot use the project compiler to read `.ts` sources.                         |
| `@swc/core`          | 1.16.2  | The parser that closes the gap. Without it the cruise reads no TypeScript at all and still exits 0. Do not drop this pin. |
| `hono`               | 4.13.9  | The API and its sign-in `verify()`. 4.13.5 is the first release fixing every 4.10.7 advisory (issue 76).                  |
| `@hono/node-server`  | 2.1.1   | The API's Node listener in `apps/api/server.ts`, so a runtime dependency.                                                 |
| `markdown-it`        | 14.3.2  | The review-evidence check's parser (issue 88). 15.x needs `argparse` 3, whose PSF-2.0 licence the licence check refuses.  |

**The measured behaviour, on 18.4.0, on 23 September 2026.** With `typescript`
7.0.2 and no alternative parser installed, `depcruise` pointed at a tree of
three TypeScript modules printed `no dependency violations found (0 modules, 0
dependencies cruised)` and exited 0. Over a mixed tree it cruised the
JavaScript, skipped the TypeScript, printed nothing on stderr and exited 0.
This was measured against 18.4.0 rather than assumed fixed from the 18.3.0 the
ticket named, and it is not fixed.

With `@swc/core` installed, dependency-cruiser reads the whole tree, and a
source it cannot parse stops the cruise: it exits 1 and writes no report at
all. `@swc/core` is therefore load bearing, not a convenience, and
`tests/ci/deps-cruise-cases.mjs` asserts the pin is present and exact.

A green that means "read nothing" is worse than a red, so the check is
`scripts/deps-cruise.mjs` and not `depcruise` directly. It fails when
dependency-cruiser returned no readable report, when zero modules were
cruised, when any source in scope was not cruised, or when any rule at
severity `error` was violated. **There is no list of files exempt from being
read, and one must not be added.** An earlier revision of the runner carried
one, and a syntactically invalid file placed at a listed path was skipped
while the runner reported that the tree had been read.

Raising `dependency-cruiser` is an ordinary reviewed change, like any other
dependency bump: it merges once every required check is green, and the
notification rules below apply to it unchanged. When a release supports
TypeScript 7, `@swc/core` may become removable, and
`tests/ci/deps-cruise-cases.mjs` will show whether it is.

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
updates; they merge like any other change, and never by Renovate itself. An
agent invokes that merge on Nathan's credential once every required check is
green on the head being merged; his is the only account with push access. It
notifies him afterwards, naming the pull request and the merged revision. That
notification records what happened; it does not ask permission. The decisions
[Contributing](../CONTRIBUTING.md#who-invokes-the-merge) reserves to Nathan
are not reachable by a green check, and a reduction of any check's tier is one
of them, so no pin here is loosened by a dependency update merging.
The merge rule: an agent merges on Nathan's credential once every required
check is green on the head being merged; a change touching one of the eight
protected components merges only on that component's green conformance proof
and Nathan's acceptance; the production deploy is the one other human gate.

## How long a new package version waits

A new version of any npm package waits 7 days after it is published before
this project can install it, so a bad release has time to be found and pulled
first. `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` (minutes);
`renovate.json` sets `"7 days"` at the top level and on every package rule.
An urgent security patch can be taken sooner by hand: a reviewed change adds
that exact version to `minimumReleaseAgeExclude`, where each entry says why.
`trustPolicy: no-downgrade` refuses a version published with weaker trust
evidence than an earlier one, the shape of a stolen publishing token, and
`blockExoticSubdeps: true` refuses a sub-dependency from a git URL or tarball.
CI's `scripts/local/semgrep-settings.sh` runs Semgrep's `p/default` on both
files and refuses a finding or a failed scan.
