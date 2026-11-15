#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# pass-main.sh [remote] [branch]: make the remote's main a commit this
# machine's gate has passed (#2507, DECISIONS 130).
#
# Main reaches the remote through merges this machine never pushed, so no
# gate-passed receipt covers it, and a new branch's first push scanned all of
# history (about 10,900 commits, up to an hour). This runs the repository's
# own pre-push hook over the remote's main exactly as a first push of it would
# run: the pushed commit's own scanners and canaries, under this shell's
# fingerprint, over every commit the gate has not passed (first_push_range, so
# from the last receipt onward). Nothing is pushed. Only a scan that is clean
# end to end appends the receipt, as a real first push would; a finding exits
# non-zero and records nothing. A lane runs it in the shell it pushes from, so
# its first push of a new branch narrows to the commits past main.
#
# Nothing here trusts what a remote says it holds: the remote only supplies
# which commit to scan, and the receipt is for what this machine scanned.
set -eu

remote=${1:-origin}
branch=${2:-main}
case "$remote/$branch" in
  *[!A-Za-z0-9._/-]* | -*) echo "pass-main: refusing an unusual remote or branch name" >&2; exit 2 ;;
esac

# Git's own diagnostics quote the remote's URL, which can hold a key or a
# denied term, so a failure here says only that it failed, in fixed words.
stop() {
  echo "pass-main: $1; recording nothing" >&2
  exit 1
}
url=$(git remote get-url --push -- "$remote" 2>/dev/null) || stop "no such remote"
git fetch -q -- "$remote" "+refs/heads/$branch:refs/remotes/$remote/$branch" >/dev/null 2>&1 ||
  stop "the fetch of the remote's branch failed"
tip=$(git rev-parse -q --verify "refs/remotes/$remote/$branch^{commit}") ||
  stop "the fetched branch is not a commit"
zero=0000000000000000000000000000000000000000
[ ${#tip} -eq 64 ] && zero=0000000000000000000000000000000000000000000000000000000000000000

# Through git itself, as a push runs it: the same hook (core.hooksPath), the
# same PATH (git puts its exec path first) and so the same fingerprint, so the
# receipt is one a real first push from this shell reads.
refs=$(mktemp)
trap 'rm -f "$refs"' EXIT
printf 'refs/heads/%s %s refs/heads/%s %s\n' "$branch" "$tip" "$branch" "$zero" > "$refs"
git hook run --to-stdin="$refs" pre-push -- "$remote" "$url"
