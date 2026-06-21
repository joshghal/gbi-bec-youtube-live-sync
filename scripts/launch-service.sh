#!/bin/bash
# Manual launch — when auto-discovery doesn't pick up an Ibadah Raya N for any reason.
#
# Usage:
#   bash scripts/launch-service.sh <N> <youtube-video-id> [duration-seconds]
#
# Example:
#   bash scripts/launch-service.sh 3 abc123XYZ12
#   bash scripts/launch-service.sh 4 abc123XYZ12 4800   # 80 min cap
#
# What it does:
#   1. Cancels any running execution (in case scheduler already fired but failed)
#   2. Triggers a fresh Cloud Run Job execution that bypasses sunday-runner
#      and calls live-summary.js DIRECTLY on the given videoId.
#   3. The image already has proxy chain + Bahasa BEC-style prompt baked in.

set -e

N="${1:?usage: bash launch-service.sh <N> <videoId> [duration-seconds]}"
VID="${2:?missing videoId}"
DUR_S="${3:-5400}"   # default 90 min
DUR_MS=$((DUR_S * 1000))

PROJECT="baranangsiang-evening-chur"
REGION="asia-southeast1"
JOB="gbi-bec-youtube-live-sync"

# Best-effort fetch the actual video title (so the kabar draft has correct pastor name)
TITLE=$(curl -s "https://www.youtube.com/watch?v=$VID" | grep -oE '"title":"[^"]+"' | head -1 | sed 's/"title":"//;s/"$//' | sed 's/\\u0026/\&/g')
TITLE="${TITLE:-Ibadah Raya $N | $(date -u +%d.%m.%Y) | GBI Baranangsiang}"
SERMON_DATE=$(TZ=Asia/Jakarta date +%Y-%m-%d)

echo "▶ Launching capture for service $N, video $VID"
echo "  Title:  $TITLE"
echo "  Date:   $SERMON_DATE"
echo "  Cap:    ${DUR_S}s ($((DUR_S/60)) min)"
echo

TOKEN=$(gcloud auth print-access-token)
RESP=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$JOB:run" \
  --data @- <<EOF
{
  "overrides": {
    "containerOverrides": [{
      "args": ["dist/live-summary.js", "https://www.youtube.com/watch?v=$VID"],
      "env": [
        {"name": "VIDEO_TITLE",        "value": $(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$TITLE")},
        {"name": "SERMON_DATE",        "value": "$SERMON_DATE"},
        {"name": "SERVICE_NUMBER",     "value": "$N"},
        {"name": "MAX_DURATION_MS",    "value": "$DUR_MS"},
        {"name": "SUMMARY_EVERY_MS",   "value": "60000"},
        {"name": "WRITE_FIRESTORE",    "value": "1"},
        {"name": "GCS_PREFIX",         "value": "run-$SERMON_DATE"}
      ]
    }]
  }
}
EOF
)

EXEC=$(echo "$RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('metadata',{}).get('name','?').split('/')[-1])")
echo "✓ Launched: $EXEC"
echo
echo "Watch logs:"
echo "  gcloud logging read 'labels.\"run.googleapis.com/execution_name\"=\"$EXEC\"' --project $PROJECT --limit 30 --format='value(textPayload)' --order=desc"
echo
echo "Console:"
echo "  https://console.cloud.google.com/run/jobs/executions/details/$REGION/$EXEC?project=$PROJECT"
