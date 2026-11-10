#!/bin/bash
# Vercel "Ignored Build Step". Exit 0 = skip the build, exit 1 = build.
# Approved conversions and learned-rule mirrors are committed to the data branch
# (default conversions-data); those commits must never trigger a deployment.
DATA_BRANCH="${GITHUB_DATA_BRANCH:-conversions-data}"
if [ "$VERCEL_GIT_COMMIT_REF" = "$DATA_BRANCH" ]; then
  echo "Data branch commit: skipping build."
  exit 0
fi
# A commit that only touches data paths does not need a build either.
if git rev-parse HEAD^ >/dev/null 2>&1 && git diff --quiet HEAD^ HEAD -- . ':(exclude)conversions' ':(exclude)skills/learned'; then
  echo "Only data paths changed: skipping build."
  exit 0
fi
exit 1
