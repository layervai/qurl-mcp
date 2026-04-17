#!/usr/bin/env bash
#
# Checks that npm packages added/updated in the current PR's lockfile diff
# have been published for at least MIN_AGE_DAYS days. Defends against
# typosquatting / dependency-confusion supply-chain attacks where a
# malicious version is published and someone pulls it in before the
# community notices.
#
# Invoked by .github/workflows/dependency-age-check.yml as:
#   MIN_AGE_DAYS=7 BASE_REF=main bash .github/scripts/check-dependency-age.sh
#
# Extracted from the workflow step body so the script can be linted
# statically (ShellCheck) and tested in isolation (e.g., with a local mock
# registry) rather than only via end-to-end CI runs.
#
# Inputs (environment):
#   MIN_AGE_DAYS         required; minimum publish age in days (positive int)
#   BASE_REF             required; base branch name (NOT `origin/<name>` — we
#                        prepend `origin/` ourselves)
#   GITHUB_STEP_SUMMARY  provided by GitHub Actions; file we append to for the
#                        workflow's step-summary panel. If unset, summary
#                        lines are silently dropped (useful for local runs).
#
# Exit codes:
#   0  all checked packages pass the quarantine threshold (or nothing to check)
#   1  one or more packages failed, or registry outage made verification impossible

set -euo pipefail

# Default GITHUB_STEP_SUMMARY to /dev/null for local runs so the append
# redirects don't error out. The workflow always provides it.
: "${GITHUB_STEP_SUMMARY:=/dev/null}"

# Sanity: jq, curl, and GNU date are pre-installed on ubuntu-latest. Fail
# loudly rather than silently skipping checks if the runner image changes.
command -v jq >/dev/null || { echo "::error::jq not available on runner"; exit 1; }
command -v curl >/dev/null || { echo "::error::curl not available on runner"; exit 1; }
# `date -d @0` catches a BSD date silently replacing GNU date — BSD date
# rejects the @-prefix epoch syntax, so the downstream `date -d "$publish_time"`
# calls would misbehave in that case.
date -d @0 >/dev/null 2>&1 || {
  echo "::error::GNU date -d not available on runner — this workflow depends on GNU date's \`@\`-prefix epoch syntax. Fix: run on an \`ubuntu-latest\` / Linux runner, or replace the \`date -d\` calls with a portable alternative (e.g., \`python -c 'from datetime import datetime; ...'\`)."
  exit 1
}

# Validate numeric input — a non-numeric MIN_AGE_DAYS would crash later at
# `$age_days -lt $MIN_AGE_DAYS` with a cryptic bash error. Require a
# positive integer: MIN_AGE_DAYS=0 would make the quarantine a no-op, which
# is worse than a misconfigured check (silent pass). Reject it explicitly.
if ! [[ "${MIN_AGE_DAYS:-}" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::MIN_AGE_DAYS must be a positive integer (got: ${MIN_AGE_DAYS:-<unset>})"
  exit 1
fi

if [ -z "${BASE_REF:-}" ]; then
  echo "::error::BASE_REF must be set (base branch name to diff against)"
  exit 1
fi

failed=false
skipped_count=0
checked_count=0
now_epoch=$(date +%s)
base_ref="origin/${BASE_REF}"

# Guard: the `|| true` on the extraction pipeline below would otherwise
# swallow a missing-base-ref failure silently (git diff returns an error
# but grep-on-empty-input exits 1 too, and `|| true` conflates them).
# Verify explicitly with a friendlier error than git diff would produce.
if ! git rev-parse --verify --quiet "${base_ref}" >/dev/null; then
  echo "::error::Base ref ${base_ref} not found in this checkout."
  exit 1
fi

# Separate the diff from the filter so a diff failure (missing base ref,
# invalid workflow_dispatch ref, etc.) doesn't silently pass as "no changes
# detected." Under `pipefail`, the `!` would otherwise invert a non-zero
# diff exit into the early-exit branch and skip the security check entirely.
name_check=$(git diff --name-only --no-renames "${base_ref}...HEAD" -- package-lock.json) \
  || { echo "::error::git diff --name-only against ${base_ref} failed"; exit 1; }
if [ -z "$name_check" ]; then
  echo "No package-lock.json changes detected"
  # Write a step-summary line so the Actions UI reflects the early-exit
  # outcome instead of an empty summary panel.
  {
    echo "## Dependency Age Check"
    echo ""
    echo "> No \`package-lock.json\` changes detected in this diff. :white_check_mark:"
  } >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

# Extract package names from added/updated "resolved" URLs in the diff.
# Two patterns cover scoped (@scope/name) and unscoped (name) packages.
# Alternative registries (GitHub Packages, private Verdaccio, etc.) are
# silently skipped by design — we can't verify their publish time from the
# public npmjs registry. Known limitations:
# - npm aliases (`npm:other-package@version`) and packages nested under
#   non-root `node_modules` won't be extracted cleanly; both are uncommon
#   in practice given npm v7+'s aggressive hoisting.
# - Mixed public/private lockfiles: if a lockfile has 1 public package
#   and 99 private packages, only the 1 public package is age-checked.
#   The all-skipped-count guard below catches the fully-private case, but
#   a partially-public lockfile can pass as long as its public packages
#   clear the threshold. This is acceptable given the alternative (refusing
#   to gate any mixed-registry lockfile) is strictly worse.
#
# Split `git diff` from the grep/sed/sort pipeline, mirroring the name_check
# pattern above. Previously the single-pipeline form with a trailing
# `|| true` would silently swallow a diff or sed failure alongside the
# expected grep-no-match exit 1. By running `git diff` first with its own
# error handler, `|| true` on the pipeline now scopes to grep/sed/sort
# only — where exit 1 genuinely means "no matching lines" (the expected
# metadata-only-diff case).
diff_output=$(git diff --no-renames "${base_ref}...HEAD" -- package-lock.json) \
  || { echo "::error::git diff against ${base_ref} failed"; exit 1; }
new_packages=$(printf '%s\n' "$diff_output" \
  | grep '^+.*"resolved"' \
  | sed -n \
    -e 's|.*https://registry.npmjs.org/\(@[^/]*/[^/]*\)/-/.*|\1|p' \
    -e 's|.*https://registry.npmjs.org/\([^@][^/]*\)/-/.*|\1|p' \
  | sort -u) || true

if [ -z "$new_packages" ]; then
  echo "No new npm packages detected"
  # Same rationale as the name_check early exit above: write a visible
  # summary line so the Actions UI doesn't show an empty panel when the
  # diff only touched non-registry fields (integrity hashes, transient-only
  # metadata).
  {
    echo "## Dependency Age Check"
    echo ""
    echo "> Lockfile changed but no new/updated npm packages detected (metadata-only diff). :white_check_mark:"
  } >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

pkg_count=$(echo "$new_packages" | wc -l | tr -d ' ')
echo "Checking ${pkg_count} new/updated package(s)..."
echo ""

# Block-redirect form (not heredoc) so the bash indentation story is
# unambiguous — every byte we want in the summary is in an explicit echo
# argument.
{
  echo "## Dependency Age Check"
  echo ""
  echo "| Package | Version | Age (days) | Status |"
  echo "|---------|---------|------------|--------|"
} >> "$GITHUB_STEP_SUMMARY"

# Validates input looks like a real npm package name. Blocks any exotic
# characters in $pkg from reaching the curl URL (defense against crafted
# lockfile entries with path-traversal / query injection in the URL path).
is_valid_pkg_name() {
  local name="$1"
  # 214 = npm's maximum package name length (includes the `@scope/` prefix
  # for scoped packages). Per npm's naming spec.
  [ ${#name} -le 214 ] || return 1
  # Uppercase and tildes are included because npm's validate-npm-package-name
  # treats them as warnings (allowed for legacy packages), not hard errors.
  # Packages like `JSONStream` (uppercase) exist in the wild, and rejecting
  # them here would emit a misleading "does not match npm package name rules"
  # warning for a legitimate lockfile entry. Shell metacharacters (`!`, `(`,
  # `)`, `*`, `'`) remain blocked — those would be dangerous in the curl URL.
  [[ "$name" =~ ^(@[a-zA-Z0-9~][a-zA-Z0-9~._-]*/)?[a-zA-Z0-9~][a-zA-Z0-9~._-]*$ ]]
}

# Fetches the registry response for $1 and emits the publish time for
# version $2 on stdout. Exit codes: 0 success (stdout may still be empty if
# the version isn't in .time); 1 = registry says 404/410 (package private or
# removed); 2 = transient failure after retry. Uses curl's native --retry
# for the transient case. Temp-file cleanup runs via `trap ... RETURN`
# (bash-only, fine on ubuntu-latest) so it happens even on unexpected exits.
#
# `RETURN` trap lifecycle: each call installs a fresh trap that fires when
# that call returns (normally or via `return N`). The previous invocation's
# trap has already fired and been discarded by that point, so there's no
# trap leak across calls even though we reassign the same trap name.
fetch_publish_time() {
  local pkg="$1" version="$2" response_file http_code
  response_file=$(mktemp)
  # We want $response_file to be expanded *now* (when the trap is set), not
  # when the trap fires — by that point `local` has already gone out of
  # scope. Using double quotes for the trap command is deliberate; single
  # quotes would defer expansion. Inner path uses escaped double quotes
  # rather than single quotes so a mktemp path containing a single quote
  # (not possible with GNU mktemp today, but defensive) wouldn't break the
  # trap command.
  # shellcheck disable=SC2064
  trap "rm -f \"$response_file\"" RETURN
  # URL-encode the `/` in scoped names (`@scope/name` → `@scope%2Fname`).
  # Both forms resolve today, but the encoded form is the canonical
  # registry API path — makes the request unambiguously correct.
  local url_pkg="${pkg/\//%2F}"
  # -sS: silent, but show errors on stderr — leaves a breadcrumb in the
  # Actions log when retries exhaust / DNS fails / etc.
  # `|| echo "000"` covers both "curl exited non-zero" and "curl crashed
  # before -w could print" — either way we fall through to the transient
  # `*)` branch in the case below.
  http_code=$(curl -sS --compressed -m 10 --retry 2 --retry-delay 2 --retry-all-errors \
    -o "$response_file" -w "%{http_code}" \
    "https://registry.npmjs.org/${url_pkg}" || echo "000")
  case "$http_code" in
    200)
      jq -r --arg v "$version" '.time[$v] // empty' "$response_file"
      return 0
      ;;
    404|410)
      return 1
      ;;
    429)
      # --retry-all-errors already retries 429; if we still got here, rate
      # limiting has exhausted retries. Log distinctly from generic
      # "unreachable" so it's diagnosable, then fall through to the same
      # fail-closed transient path. Must go to stderr — stdout is captured
      # by `$(fetch_publish_time …)` at the call site.
      echo "::warning::${pkg} — rate-limited by npm registry (429); --retry exhausted" >&2
      return 2
      ;;
    *)
      return 2
      ;;
  esac
}

# Sanitize arbitrary strings before writing them to $GITHUB_STEP_SUMMARY.
# Used for values that either pre-date is_valid_pkg_name (the invalid-name
# branch below) or come from jq on the lockfile (version strings — semver
# is well constrained but a malicious lockfile could stuff markdown in).
# Strips to the set that can't form active markdown and caps length so an
# over-long entry can't blow out the summary.
safe_for_md() {
  printf '%s' "$1" | tr -cd '[:alnum:]@/_.:+-' | head -c 80
}

# Note: unquoted $new_packages is intentional — npm package names cannot
# contain whitespace, so word-splitting is the desired iteration behavior.
# shellcheck disable=SC2086
for pkg in $new_packages; do
  if ! is_valid_pkg_name "$pkg"; then
    safe_pkg=$(safe_for_md "$pkg")
    echo "::warning::${safe_pkg} — does not match npm package name rules (skipped)"
    echo "| \`${safe_pkg}\` | — | — | :warning: invalid name (skipped) |" >> "$GITHUB_STEP_SUMMARY"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  # The `.packages["node_modules/${pkg}"]` path is the lockfile v3
  # structure (npm 7+). CI pins Node 20+ / npm 10+, so we'll always emit
  # v3 lockfiles; a v1 lockfile would store packages under `.dependencies`
  # and those entries would miss this lookup.
  #
  # `2>/dev/null || true` so a malformed/unparseable lockfile yields a
  # clean per-package skip via the `-z "$version"` branch below rather
  # than aborting the whole run under `set -e`. The stderr suppression
  # matches the per-package-skip posture elsewhere — a failure here is
  # expected if a future lockfile includes something jq can't parse.
  version=$(jq -r --arg p "node_modules/${pkg}" \
    '.packages[$p].version // empty' package-lock.json 2>/dev/null || true)
  if [ -z "$version" ]; then
    echo "::warning::${pkg} — could not determine installed version from lockfile (skipped)"
    echo "| \`${pkg}\` | — | — | :warning: skipped (no version in lockfile) |" >> "$GITHUB_STEP_SUMMARY"
    skipped_count=$((skipped_count + 1))
    continue
  fi
  # jq output flows into step-summary cells below; sanitize so a crafted
  # lockfile version string can't inject markdown.
  safe_ver=$(safe_for_md "$version")

  # ~5 req/sec — npm's public registry doesn't document a hard rate limit
  # but historically throttles at higher rates. With the 5-min job timeout
  # this supports ~1500 packages, well above realistic lockfile diffs.
  # --retry-all-errors on the curl call above handles any 429 that does
  # slip through.
  sleep 0.2

  fetch_rc=0
  publish_time=$(fetch_publish_time "$pkg" "$version") || fetch_rc=$?

  case "$fetch_rc" in
    0)
      if [ -z "$publish_time" ]; then
        echo "::warning::${pkg}@${safe_ver} — version not in registry timestamps (skipped)"
        echo "| \`${pkg}\` | ${safe_ver} | — | :warning: skipped (version not in registry) |" >> "$GITHUB_STEP_SUMMARY"
        skipped_count=$((skipped_count + 1))
        continue
      fi
      ;;
    1)
      # 404/410 — package not on npmjs (private registry, scope-only, or unpublished).
      # Skip with warning; no way to verify age from public metadata.
      echo "::warning::${pkg}@${safe_ver} — not found on npmjs.org (private or unpublished; skipped)"
      echo "| \`${pkg}\` | ${safe_ver} | — | :warning: skipped (404 — private or unpublished) |" >> "$GITHUB_STEP_SUMMARY"
      skipped_count=$((skipped_count + 1))
      continue
      ;;
    *)
      # Transient failure after curl --retry. Fail closed — an outage must
      # not silently let new deps through a security control.
      echo "::error::${pkg}@${safe_ver} — registry unreachable after retry"
      echo "| \`${pkg}\` | ${safe_ver} | — | :x: registry unreachable |" >> "$GITHUB_STEP_SUMMARY"
      failed=true
      continue
      ;;
  esac

  publish_epoch=$(date -d "$publish_time" +%s 2>/dev/null || echo "0")
  if [ "$publish_epoch" -eq 0 ]; then
    echo "::error::Could not parse publish timestamp for ${pkg}@${safe_ver}"
    echo "| \`${pkg}\` | ${safe_ver} | — | :x: parse error |" >> "$GITHUB_STEP_SUMMARY"
    failed=true
    continue
  fi

  age_days=$(( (now_epoch - publish_epoch) / 86400 ))
  checked_count=$((checked_count + 1))

  if [ "$age_days" -lt "$MIN_AGE_DAYS" ]; then
    # Compute when the package will be eligible so developers know when to
    # retry without needing the bypass label.
    eligible_date=$(date -u -d "@$((publish_epoch + MIN_AGE_DAYS * 86400))" +%Y-%m-%d 2>/dev/null || echo "unknown")
    echo "::error::${pkg}@${safe_ver} published ${age_days} day(s) ago (minimum: ${MIN_AGE_DAYS}; eligible after ${eligible_date})"
    echo "| \`${pkg}\` | ${safe_ver} | ${age_days} | :x: **too new** (eligible after ${eligible_date}) |" >> "$GITHUB_STEP_SUMMARY"
    failed=true
  elif [ "$age_days" -le "$((MIN_AGE_DAYS + 1))" ]; then
    # Package just barely passed the threshold. Surface as a notice so
    # maintainers know to keep an eye on it — if the package is unpublished
    # or the threshold is raised slightly, it'll flip to failing on a
    # future PR.
    echo "::notice::${pkg}@${safe_ver} is ${age_days} day(s) old — just past the ${MIN_AGE_DAYS}-day threshold"
    echo "  OK: ${pkg}@${safe_ver} (${age_days} days old, barely past threshold)"
    echo "| \`${pkg}\` | ${safe_ver} | ${age_days} | :eyes: just past threshold |" >> "$GITHUB_STEP_SUMMARY"
  else
    echo "  OK: ${pkg}@${safe_ver} (${age_days} days old)"
    echo "| \`${pkg}\` | ${safe_ver} | ${age_days} | :white_check_mark: |" >> "$GITHUB_STEP_SUMMARY"
  fi
done

# Guard against "registry outage makes every package get skipped and the
# workflow passes" — if nothing actually got verified, fail.
if [ "$checked_count" -eq 0 ] && [ "$skipped_count" -gt 0 ]; then
  {
    echo ""
    echo "> **No packages could be verified** (all ${skipped_count} were skipped). Treating as failure to avoid silent pass on registry outage."
  } >> "$GITHUB_STEP_SUMMARY"
  echo "::error::All ${skipped_count} packages were skipped; no verification possible. Failing to avoid a false pass."
  exit 1
fi

if [ "$failed" = true ]; then
  {
    echo ""
    echo "> **One or more dependencies failed the ${MIN_AGE_DAYS}-day age check.** Add the \`age-check-bypass\` label to override."
  } >> "$GITHUB_STEP_SUMMARY"
  echo ""
  echo "::error::One or more npm dependencies failed the age check."
  echo "To bypass for emergency updates, add the 'age-check-bypass' label to this PR."
  exit 1
fi

{
  echo ""
  echo "> Verified ${checked_count} of ${pkg_count} packages at ≥ ${MIN_AGE_DAYS} days old. :white_check_mark:"
  if [ "$skipped_count" -gt 0 ]; then
    echo "> ${skipped_count} skipped (see warnings above)."
  fi
} >> "$GITHUB_STEP_SUMMARY"
echo "All verified npm dependencies are at least ${MIN_AGE_DAYS} days old"
