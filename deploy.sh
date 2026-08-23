#!/bin/bash
# Deploy gbi-bec-youtube-live-sync as Cloud Run Job + 5 Cloud Schedulers.
#
# Prerequisites (one-time):
#   - GCS bucket "gbi-bec-sermon-captures" exists (deploy.sh creates it)
#   - Secret Manager has "gemini-api-key", "youtube-api-key" (already in place —
#     the latter powers the clean YouTube Data API discovery/poller path; without
#     it the job silently falls back to HTML-scraping discovery and the Item-1
#     poller-based finalize logic in live-summary.ts degrades to its silence-only
#     fallback. --env-vars-file below REPLACES the full env list on every deploy,
#     so any ad-hoc `--update-env-vars` addition not also added here gets wiped
#     on the next run — that's exactly what silently dropped this key on 2026-08-23.)
#   - Required env vars: ASI1_API_KEY
#
# Schedules (Asia/Jakarta = WIB):
#   service 5: 17:30  (cron: 30 17 * * 0)  — BEC Evening Church (the only one we capture)
#
# Services 1-4 (morning) were removed Jun 21 2026 — BEC primary service is evening.
#
# Run: bash deploy.sh

set -e

PROJECT_ID="baranangsiang-evening-chur"
REGION="asia-southeast1"
IMAGE="gcr.io/$PROJECT_ID/gbi-bec-youtube-live-sync"
JOB_NAME="gbi-bec-youtube-live-sync"
BUCKET="gbi-bec-sermon-captures"
COMPUTE_SA="100937908314-compute@developer.gserviceaccount.com"
SCHEDULER_SA="$COMPUTE_SA"

if [ -z "$ASI1_API_KEY" ]; then
  echo "ERROR: ASI1_API_KEY env var required" >&2
  exit 1
fi

# 1) GCS bucket for transcript outputs
echo "==> Ensuring GCS bucket gs://$BUCKET ..."
gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$BUCKET" \
    --project "$PROJECT_ID" \
    --location "$REGION" \
    --uniform-bucket-level-access \
    --default-storage-class STANDARD
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$COMPUTE_SA" \
  --role="roles/storage.objectAdmin" \
  --project "$PROJECT_ID" >/dev/null

# 2) Build & push image
echo "==> Building image $IMAGE ..."
gcloud builds submit --tag "$IMAGE" --project "$PROJECT_ID" .

# 3) Per-execution env vars (no SA JSON needed — ADC on Cloud Run gets it from attached SA)
ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
cat > "$ENV_FILE" <<EOF
ASI1_API_KEY: "$ASI1_API_KEY"
YOUTUBE_CHANNEL_ID: "UChwc7uyPrVVGZ0TcZ_-Jdhg"
GCS_BUCKET: "$BUCKET"
CAPTURE_DURATION_MS: "5400000"
SUMMARY_EVERY_MS: "60000"
WRITE_FIRESTORE: "1"
YOUTUBE_COOKIES_PATH: "/secrets/youtube-cookies.txt"
EOF

# 4) Create or update the Cloud Run Job
echo "==> Creating / updating Cloud Run Job $JOB_NAME ..."
gcloud run jobs create "$JOB_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --env-vars-file "$ENV_FILE" \
  --set-secrets "GEMINI_API_KEY=gemini-api-key:latest,WEBSHARE_TOKEN=webshare-api-token:latest,PROXIES=webshare-proxies:latest,YOUTUBE_API_KEY=youtube-api-key:latest,/secrets/youtube-cookies.txt=youtube-cookies:latest" \
  --memory 2Gi \
  --cpu 2 \
  --max-retries 0 \
  --task-timeout 7200s \
  --service-account "$COMPUTE_SA" \
  2>/dev/null || \
gcloud run jobs update "$JOB_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --env-vars-file "$ENV_FILE" \
  --set-secrets "GEMINI_API_KEY=gemini-api-key:latest,WEBSHARE_TOKEN=webshare-api-token:latest,PROXIES=webshare-proxies:latest,YOUTUBE_API_KEY=youtube-api-key:latest,/secrets/youtube-cookies.txt=youtube-cookies:latest" \
  --memory 2Gi \
  --cpu 2 \
  --max-retries 0 \
  --task-timeout 7200s \
  --service-account "$COMPUTE_SA"

# 5) Grant scheduler SA permission to invoke the job
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SCHEDULER_SA" \
  --role="roles/run.invoker" >/dev/null 2>&1 || true

# 6) Five Cloud Schedulers — each with its own SERVICE_NUMBER override
RUN_URI="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/$JOB_NAME:run"
declare -a SCHEDULES=(
  "5|30 17 * * 0"
)

for entry in "${SCHEDULES[@]}"; do
  N="${entry%%|*}"
  CRON="${entry#*|}"
  SCHED_NAME="$JOB_NAME-service-$N"
  BODY=$(cat <<EOF
{
  "overrides": {
    "containerOverrides": [{
      "env": [
        {"name": "SERVICE_NUMBER", "value": "$N"}
      ]
    }]
  }
}
EOF
)
  echo "==> Scheduler $SCHED_NAME @ '$CRON' Asia/Jakarta (service $N)"
  gcloud scheduler jobs create http "$SCHED_NAME" \
    --location "$REGION" \
    --project "$PROJECT_ID" \
    --schedule "$CRON" \
    --time-zone "Asia/Jakarta" \
    --uri "$RUN_URI" \
    --http-method POST \
    --headers "Content-Type=application/json" \
    --message-body "$BODY" \
    --oauth-service-account-email "$SCHEDULER_SA" \
    2>/dev/null || \
  gcloud scheduler jobs update http "$SCHED_NAME" \
    --location "$REGION" \
    --project "$PROJECT_ID" \
    --schedule "$CRON" \
    --time-zone "Asia/Jakarta" \
    --uri "$RUN_URI" \
    --http-method POST \
    --update-headers "Content-Type=application/json" \
    --message-body "$BODY" \
    --oauth-service-account-email "$SCHEDULER_SA"
done

echo ""
echo "Done. Manual test (service 5, picks current live Ibadah Raya 5 if any):"
echo "  gcloud run jobs execute $JOB_NAME --region $REGION --project $PROJECT_ID \\"
echo "    --update-env-vars SERVICE_NUMBER=5 --wait"
echo ""
echo "View outputs: https://console.cloud.google.com/storage/browser/$BUCKET?project=$PROJECT_ID"
