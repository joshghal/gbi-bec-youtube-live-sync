# Sunday Run Procedure

How to capture and summarize all 5 GBI Baranangsiang services on a Sunday.

## What this does

The `sunday-runner.ts` orchestrator:

1. Polls the GBI BARSI YouTube channel RSS every 5 minutes.
2. When it detects a new "Ibadah Raya N" livestream that started today (WIB), it records it.
3. **20 minutes after that stream went live**, spawns `live-summary.ts` as a child process.
4. The child captures audio for 90 minutes (default), transcribes via Gemini 3.1 Flash Live, and produces rolling summaries via ASI1 Mini every 60 seconds.
5. Each service's output lands in `runs/run-{YYYY-MM-DD}/service-{N}-{videoId}/{transcript.txt, summaries.json, meta.json}`.
6. Persistent `state.json` allows safe restarts.

## Pre-flight (do this Saturday night)

```bash
cd /Users/joshuagalilea/Documents/personal/ideation/gbi-bec-youtube-live-sync

# Verify deps
npm install

# Verify Gemini key is still in Secret Manager
gcloud secrets versions access latest \
  --secret=gemini-api-key --project=baranangsiang-evening-chur > /dev/null && echo "✓ Gemini key OK"

# Type check
npx tsc --noEmit && echo "✓ Type check OK"

# Confirm the channel still streams (probe today)
yt-dlp --no-update --quiet --no-warnings --print "%(is_live)s|%(title)s" \
  "https://www.youtube.com/@gbibaranangsiangsukawarna7008/streams" 2>/dev/null | head -5
```

## Run on Sunday morning

**Start before the first service** (ideally 06:30 WIB if Service 1 begins at 07:00 WIB). The runner blocks the foreground — leave the terminal window open all day.

```bash
cd /Users/joshuagalilea/Documents/personal/ideation/gbi-bec-youtube-live-sync

GEMINI_API_KEY=$(gcloud secrets versions access latest \
    --secret=gemini-api-key --project=baranangsiang-evening-chur) \
  ASI1_API_KEY="<your-asi1-key>" \
  npx tsx src/sunday-runner.ts
```

Output stream looks like:

```
[2026-06-15T00:00:00Z] Sunday runner starting
[2026-06-15T00:00:00Z] Channel:  UChwc7uyPrVVGZ0TcZ_-Jdhg
[2026-06-15T00:00:00Z] Today:    2026-06-15 (WIB)
[2026-06-15T00:00:00Z] Run dir:  ./runs/run-2026-06-15
[2026-06-15T00:00:00Z] Cadence:  poll every 5 min · trigger +20 min after stream start · capture 90 min

[2026-06-15T00:05:00Z] poll: 1 sermon entries today
[2026-06-15T00:05:00Z]   + NEW: service 1 (xxxxxxxxxxx) "Ibadah Raya 1 | ..." — went live at 2026-06-15T00:00:00Z
[2026-06-15T00:05:00Z] ▶ scheduled service 1 (xxx...) to start in 15.0 min
[2026-06-15T00:20:00Z] ▶▶ STARTING capture: service 1 (xxx...) → ./runs/run-2026-06-15/service-1-xxx
...
```

## Output layout per Sunday

```
runs/run-2026-06-15/
├── state.json                         ← machine-readable state of all 5 services
├── service-1-{videoId}/
│   ├── transcript.txt                 ← raw Gemini transcription
│   ├── summaries.json                 ← ASI1 rolling summaries with timestamps
│   └── meta.json                      ← run metadata (chars, duration, model)
├── service-2-{videoId}/
├── service-3-{videoId}/
├── service-4-{videoId}/
└── service-5-{videoId}/
```

## Knobs (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `POLL_INTERVAL_MS` | 300000 (5 min) | how often to poll channel RSS |
| `TRIGGER_DELAY_MS` | 1200000 (20 min) | delay between stream going live and engine starting |
| `CAPTURE_DURATION_MS` | 5400000 (90 min) | max capture per service |
| `SUMMARY_EVERY_MS` | 60000 (1 min) | rolling-summary cadence |
| `RUN_DIR` | `./runs/run-{date}` | where to write artifacts + state |
| `YOUTUBE_CHANNEL_ID` | `UChwc7uyPrVVGZ0TcZ_-Jdhg` | GBI BARSI channel |
| `FAKE_LIVE_NOW` | unset | testing escape hatch: `<videoId>:<serviceN>` triggers immediately |

## Troubleshooting

**Runner crashed mid-capture.** Restart it; `state.json` is preserved. Services with `status: "detected"` or `status: "scheduled"` will be re-scheduled. A service that was `status: "running"` when the crash happened won't auto-resume (orphaned child) — manually re-run with `FAKE_LIVE_NOW=<videoId>:<N>`.

**Service didn't get captured.** Check `runs/run-{date}/state.json`. If the service appears with `status: "failed"` → see its `error` field. If it's missing entirely → the RSS feed didn't surface it within the poll window (rare, may indicate a title pattern that doesn't match `/Ibadah\s+Raya\s+(\d+)/i`).

**Runner started late (after first service began).** The first service's `scheduledStartAt` will be in the past. The engine fires immediately, but yt-dlp will only capture from the CURRENT live position — you'll miss the earlier portion. Acceptable for trial/error; for full coverage start the runner before 07:00 WIB.

**Two services overlap.** Multiple child processes run concurrently. Each captures its own video independently. Resource overhead is low (~50MB RAM per active capture).

## Why "20 minutes after stream start"?

- Service starts at HH:00 WIB (e.g., 07:00).
- Worship + announcements typically run for the first 20-30 min.
- Sermon proper usually begins ~25-30 min in.
- Starting the engine at +20 min:
  - Skips most worship music (which the model would transcribe as garbled lyrics)
  - Catches the announcement-to-sermon transition
  - Captures the full sermon content

Adjust `TRIGGER_DELAY_MS` per actual BEC service flow if needed.

## After the day

```bash
# Quick survey of what got captured
cat runs/run-$(date +%Y-%m-%d)/state.json | python3 -c "
import json, sys
state = json.load(sys.stdin)
for vid, s in sorted(state['services'].items(), key=lambda kv: kv[1]['serviceNumber']):
    chars = ''
    try:
        with open(s.get('outputDir','')+'/meta.json') as f:
            chars = f' · {json.load(f).get(\"transcriptChars\",\"?\")} chars'
    except: pass
    print(f\"  service {s['serviceNumber']:2}  {s['status']:12} {vid}{chars}\")
"
```

## Cleanup if you want

Each Sunday creates a new `runs/run-{date}/` dir. They're disposable — copy what you want to keep, then `rm -rf` the rest.

## Reverting to the post-stream cron

The `gbi-bec-youtube-sermon-sync` Cloud Run job + Cloud Scheduler are **paused, not deleted**. To re-enable the Monday 08:00 WIB post-stream cron:

```bash
gcloud scheduler jobs resume gbi-bec-youtube-sermon-sync-trigger \
  --location asia-southeast1 --project baranangsiang-evening-chur
```
