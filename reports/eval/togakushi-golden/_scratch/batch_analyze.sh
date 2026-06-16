#!/bin/bash
set -euo pipefail
# Batch analyze: Finder-copy each source clip → analyze → delete local copy
# Runs inside internal disk (22GB free), processing 1-3 clips at a time.

REPO="/Users/mocchalera/Dev/video-os-v2-spec"
PROJ="$REPO/projects/togakushi-camp"
STAGING="$REPO/reports/eval/togakushi-golden/_staging"
POOL_JSON="$REPO/reports/eval/togakushi-golden/_scratch/analysis_pool.json"
VOLUME_FOLDER="00戸隠キャンプ "  # trailing space!
LOG="$REPO/reports/eval/togakushi-golden/_scratch/batch_analyze.log"

mkdir -p "$STAGING"

# Read file list from JSON
FILES=$(python3 -c "import json; d=json.load(open('$POOL_JSON')); print('\n'.join(d['files']))")
TOTAL=$(echo "$FILES" | wc -l | tr -d ' ')
echo "$(date +%T) Starting batch analyze: $TOTAL files" | tee "$LOG"

COUNT=0
FAIL=0
for F in $FILES; do
  COUNT=$((COUNT+1))
  echo "$(date +%T) [$COUNT/$TOTAL] $F" | tee -a "$LOG"

  # Skip if already analyzed (asset exists in 03_analysis/assets.json)
  if [ -f "$PROJ/03_analysis/assets.json" ]; then
    # Check if this filename is already in assets
    BASE=$(echo "$F" | sed 's/\.MOV$//')
    if python3 -c "
import json,sys
a=json.load(open('$PROJ/03_analysis/assets.json'))
names=[i.get('display_name','') for i in a.get('items',[])]
sys.exit(0 if '$BASE' in names else 1)
" 2>/dev/null; then
      echo "  -> SKIP (already analyzed)" | tee -a "$LOG"
      continue
    fi
  fi

  # 1) Finder-copy from external volume
  echo "  -> Copying via Finder..." | tee -a "$LOG"
  osascript -e "
tell application \"Finder\"
  set destFolder to (POSIX file \"$STAGING\" as alias)
  duplicate file \"$F\" of folder \"$VOLUME_FOLDER\" of disk \"DATA02-4G\" to destFolder with replacing
end tell
" 2>>"$LOG" || {
    echo "  -> COPY FAILED, skipping" | tee -a "$LOG"
    FAIL=$((FAIL+1))
    continue
  }

  # 2) Analyze (absolute path required — pipeline resolves relative to projectDir)
  echo "  -> Analyzing..." | tee -a "$LOG"
  cd "$REPO"
  ABS_SRC="$(cd "$STAGING" && pwd)/$F"
  npx tsx scripts/analyze.ts \
    "$ABS_SRC" \
    --project "$PROJ" \
    --language ja \
    --content-hint "戸隠高原の家族キャンプPV（クライアント：長野市観光協会）" \
    --skip-marlin \
    --skip-preflight \
    --skip-media-link \
    2>>"$LOG" | tail -5 | tee -a "$LOG" || {
    echo "  -> ANALYZE FAILED" | tee -a "$LOG"
    FAIL=$((FAIL+1))
  }

  # 3) Delete local copy to free disk
  rm -f "$STAGING/$F"
  echo "  -> Done, local copy removed" | tee -a "$LOG"
done

echo "$(date +%T) Batch complete: $COUNT processed, $FAIL failed" | tee -a "$LOG"
echo "Output: $PROJ/03_analysis/"
