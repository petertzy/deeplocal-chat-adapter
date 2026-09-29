#!/usr/bin/env bash

set -euo pipefail

REPOSITORY="${GITHUB_REPOSITORY:-petertzy/deeplocal-chat-adapter}"
LABEL="${ISSUE_LABEL:-enhancement}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
DRAFT_DIR="${ISSUE_DRAFT_DIR:-${PROJECT_ROOT}/docs/issues/proposed}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: GitHub CLI (gh) is required. Install it from https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "Error: GitHub CLI is not authenticated for github.com. Run: gh auth login -h github.com" >&2
  exit 1
fi

if [[ ! -d "${DRAFT_DIR}" ]]; then
  echo "Error: issue draft directory does not exist: ${DRAFT_DIR}" >&2
  exit 1
fi

shopt -s nullglob
drafts=("${DRAFT_DIR}"/*.md)
if (( ${#drafts[@]} == 0 )); then
  echo "No Markdown issue drafts found in ${DRAFT_DIR}."
  exit 0
fi

if ! gh repo view "${REPOSITORY}" --json nameWithOwner >/dev/null; then
  echo "Error: cannot access repository ${REPOSITORY}." >&2
  exit 1
fi

created=0
skipped=0
failed=0

for draft in "${drafts[@]}"; do
  title="$(sed -n '1s/^# //p' "${draft}")"
  if [[ -z "${title}" ]]; then
    echo "Skipping ${draft}: first line must be a Markdown H1 issue title." >&2
    ((skipped += 1))
    continue
  fi

  # GitHub's issue search includes pull requests, so compare titles and exclude PRs.
  escaped_title="${title//\\/\\\\}"
  escaped_title="${escaped_title//\"/\\\"}"
  query="repo:${REPOSITORY} is:issue in:title \"${escaped_title}\""
  existing="$(gh issue list --repo "${REPOSITORY}" --state all --search "${query}" --json title,url --limit 100)"
  if EXISTING_JSON="${existing}" ISSUE_TITLE="${title}" python3 -c '
import json, os, sys
items = json.load(sys.stdin)
title = os.environ["ISSUE_TITLE"]
matches = [item for item in items if item.get("title", "").casefold() == title.casefold()]
for item in matches:
    print(item.get("url", ""))
sys.exit(0 if matches else 1)
' <<<"${existing}"; then
    echo "Skipping already published issue: ${title}"
    ((skipped += 1))
    continue
  fi

  echo "Publishing: ${title}"
  if url="$(gh issue create --repo "${REPOSITORY}" --title "${title}" --body-file "${draft}" --label "${LABEL}")"; then
    echo "Created: ${url}"
    ((created += 1))
  else
    echo "Failed to publish: ${title}" >&2
    ((failed += 1))
  fi
done

echo "Finished: ${created} created, ${skipped} skipped, ${failed} failed."
(( failed == 0 ))
