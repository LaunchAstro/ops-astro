#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Points every worktree of this clone at hook dispatchers kept in the common
# Git directory, so no checkout can push or commit with its hooks skipped.
#
# Husky sets core.hooksPath to .husky/_, a folder `pnpm install` generates
# inside each checkout. The setting is shared by every worktree of a clone,
# and Git runs no hook at all, and says nothing, when that folder is missing:
# a worktree that was never installed publishes with no pre-push scan. A
# tracked folder would not help a worktree on a commit from before it. The
# common Git directory exists for every worktree, whatever commit it is on, so
# the dispatchers live there. Each one runs the checkout's own husky hook when
# it is installed, keeps husky's explicit HUSKY=0, and otherwise refuses.
#
# Run by the package's prepare step after husky, and by the pre-commit hook,
# which puts the setting back after an older commit's install points it at
# .husky/_ again. Outside a Git checkout (an install inside an image build)
# it does nothing.

set -eu

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
dispatch=$(git rev-parse --path-format=absolute --git-common-dir)/hook-dispatch
mkdir -p "$dispatch"

for hook in pre-commit commit-msg pre-push; do
  cat > "$dispatch/$hook.new" <<EOF
#!/bin/sh
# Written by scripts/hook-dispatch.sh. Shared by every worktree of this clone.
top=\$(git rev-parse --show-toplevel 2>/dev/null) || top=.
if [ -f "\$top/.husky/_/h" ] && [ -f "\$top/.husky/_/$hook" ]; then
  exec sh "\$top/.husky/_/$hook" "\$@"
fi
[ "\${HUSKY-}" = "0" ] && exit 0
echo "$hook: this checkout has no installed hooks (\$top/.husky/_ is missing)." >&2
echo "$hook: run pnpm install in it, then try again. Refusing." >&2
exit 1
EOF
  chmod +x "$dispatch/$hook.new"
  if cmp -s "$dispatch/$hook.new" "$dispatch/$hook"; then
    rm -f "$dispatch/$hook.new"
  else
    mv -f "$dispatch/$hook.new" "$dispatch/$hook"
  fi
done

if [ "$(git config core.hooksPath || true)" != "$dispatch" ]; then
  git config core.hooksPath "$dispatch"
fi
