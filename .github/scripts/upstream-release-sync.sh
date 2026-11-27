#!/usr/bin/env bash
# Merges an upstream EmDash release (an `emdash@X.Y.Z` tag on emdash-cms/emdash) into this fork's main through a pull
# request. The fork follows releases, not upstream's main: unreleased upstream work arrives with the release that ships it.
#
#   upstream-release-sync.sh [tag]    # default: the newest stable emdash@ release
#
# Needs: a checkout of the fork's main with full history, the `upstream` remote fetchable, and gh authenticated with a
# token that may push branches (including workflow files) and open pull requests. DRY_RUN=1 stops before pushing.
# EXTRACT_CATALOGS, when set, is the command that regenerates the admin's translation catalogs after a clean merge.
set -euo pipefail

UPSTREAM_URL="https://github.com/emdash-cms/emdash.git"
requested="${1:-}"

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
git fetch --quiet upstream --tags --force

if [[ -n "$requested" ]]; then
	tag="$requested"
else
	# Stable releases only: prereleases (emdash@1.7.0-beta.1) wait for their release.
	tag="$(git tag -l 'emdash@*' --sort=-v:refname | grep -Ev -- '-[a-z]' | head -1)"
fi
if [[ -z "$tag" ]] || ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
	echo "::error::No upstream release tag ${tag:-emdash@*} found."
	exit 1
fi
version="${tag#emdash@}"
notes="https://github.com/emdash-cms/emdash/releases/tag/emdash%40$version"

if git merge-base --is-ancestor "$tag" HEAD; then
	echo "main already contains $tag."
	exit 0
fi

branch="sync/emdash-$version"
open="$(gh pr list --head "$branch" --state open --json number --jq 'length')"
if [[ "$open" != "0" ]]; then
	echo "A pull request for $tag is already open."
	exit 0
fi

git switch --quiet -C "$branch"
conflicts=""
if ! git merge --no-ff --no-edit -m "chore: sync upstream $tag" "$tag"; then
	# Translation catalogs are generated: take upstream's and extract them again below. Anything else needs a person.
	while IFS= read -r path; do
		[[ "$path" == *.po ]] && git checkout --quiet --theirs -- "$path" && git add -- "$path"
	done < <(git diff --name-only --diff-filter=U)
	conflicts="$(git diff --name-only --diff-filter=U)"
	if [[ -z "$conflicts" ]]; then
		git commit --quiet --no-edit
	else
		git merge --abort
		# The pull request offers the release itself; GitHub shows the conflicts and the body says how to resolve them.
		git reset --quiet --hard "$tag"
	fi
fi
if [[ -z "$conflicts" && -n "${EXTRACT_CATALOGS:-}" ]]; then
	# The fork's own admin strings go back into the catalogs that upstream's replaced.
	bash -c "$EXTRACT_CATALOGS"
	if [[ -n "$(git status --porcelain -- 'packages/admin/src/locales')" ]]; then
		git add -- packages/admin/src/locales
		git commit --quiet -m "chore: extract admin catalogs for the fork's builds"
	fi
fi

if [[ "${DRY_RUN:-}" == "1" ]]; then
	echo "Dry run: would push $branch for $tag (conflicts: ${conflicts:-none})."
	exit 0
fi

git push --quiet --force origin "HEAD:refs/heads/$branch"

body_file="$(mktemp)"
if [[ -z "$conflicts" ]]; then
	cat >"$body_file" <<EOF
## What does this PR do?

Merges upstream EmDash **$tag** into the fork. The merge applied cleanly; CI checks it with the fork's changes.

Release notes: $notes

After merging, vendor the fork into the CMS (\`node scripts/vendor-emdash.mjs\` in machanigroup/cms) to deploy it.

## Type of change

- [x] Chore (dependencies, CI, tooling)

## AI assistance disclosure

- [ ] This PR includes AI-generated code or text: opened by the upstream release sync workflow
EOF
	gh pr create --base main --head "$branch" --title "chore: sync upstream $tag" --body-file "$body_file"
else
	{
		cat <<EOF
## What does this PR do?

Upstream EmDash **$tag** doesn't merge cleanly into the fork. This branch is the release itself; resolve the conflicts below, then merge.

Release notes: $notes

Conflicting files:

EOF
		while IFS= read -r path; do printf -- '- \`%s\`\n' "$path"; done <<<"$conflicts"
		cat <<EOF

Translation catalogs (\`messages.po\`) aren't listed: take upstream's, then run \`pnpm locale:extract\`.

To resolve locally:

\`\`\`sh
git fetch origin && git switch -c resolve/emdash-$version origin/main
git fetch upstream --tags && git merge $tag
git checkout --theirs -- 'packages/admin/src/locales/*/messages.po' && pnpm locale:extract
# fix the remaining conflicts, run the checks, then push and open a pull request into main
\`\`\`

## Type of change

- [x] Chore (dependencies, CI, tooling)
EOF
	} >"$body_file"
	gh pr create --draft --base main --head "$branch" --title "chore: sync upstream $tag (conflicts)" --body-file "$body_file"
fi
