# HLD — Sermon Capture Resilience

Status: all four items implemented and deployed. Item 1 stress-tested E2E
(poller unit tests, real silence-simulation, concurrency). Item 2 confirmed
pre-existing in code (pending human confirmation the WhatsApp alert actually
reached the admin on the day of the incident — the one item that needs a
person, not a test, to close out). Item 4 tested against real production
data, including a real bug the testing itself caught and fixed (see §5).
Item 3 built, and tested live against the real deployed job — see §4 for a
mistake made and caught along the way (first live test ran against a stale
image, wasted ~10 min of real compute before being caught and cancelled).

## 1. Problem

On 2026-08-23, service 5's live capture failed 64 seconds after starting.
Root cause (confirmed via full Cloud Run log trace): mid-broadcast, YouTube
reassigned the HLS stream to a different CDN edge host. Segment fetches to the
new host started returning `HTTP 403`. ffmpeg retried on its own for ~71s;
our silence watchdog (`SILENCE_WATCHDOG_MS`, 60s default) read that as "the
stream ended" and finalized with a 129-character transcript — too short to
summarize. Nothing published. The failure wasn't detected until hours later,
when someone happened to check.

Nothing in our own request logic caused this (single clean proxy attempt,
single clean manifest fetch, zero retries before ffmpeg started) — the edge
handoff and subsequent 403s are internal to ffmpeg's HLS engine reacting to
YouTube's own server-side routing decision. A control test (same method,
same ~90s window, against an unrelated live stream) reproduced zero errors,
consistent with this being a rare, not-systemic event.

Four changes close the gap between "this can still happen" and "when it
happens, we don't lose the sermon and we know within minutes, not hours":

| # | Component | Failure mode it addresses | Repo |
|---|---|---|---|
| 1 | 30-min floor + poller-based cutting | The watchdog gives up too early on a recoverable blip | `gbi-bec-youtube-live-sync` |
| 2 | Alerting on short/failed captures | Nobody finds out until hours later | `gbi-bec-portal` |
| 3 | Manual re-run trigger | No way to recover *while the stream is still live* | `gbi-bec-portal` (+ Cloud Run Jobs API) |
| 4 | On-demand execution log viewer | Diagnosing requires `gcloud` CLI access nobody but the operator has | `gbi-bec-portal` (+ Cloud Logging API) |

These are layered, not redundant: #1 prevents the common case from becoming
an incident at all; #2 shortens time-to-detection for whatever #1 doesn't
catch; #3 turns a detected failure into a recoverable one, *if* caught while
the service is still running; #4 makes every incident (whether #1 caught it
or not) diagnosable by whoever's on call, without shell/gcloud access.

---

## 2. Item 1 — 30-min floor + poller-based cutting

**Where:** `src/live-summary.ts` (already written, see `MIN_CAPTURE_FLOOR_MS`,
`LIVE_POLL_MS`, `checkStreamStillLive`).

**Mechanism:**
- For the first 30 minutes after first audio arrives, nothing can finalize
  the capture — no matter what ffmpeg or the CDN does. A transient blip like
  today's gets ridden out instead of killing the capture.
- After the floor, cutting is driven by a poller: every 60s, ask the
  YouTube Data API (`videos.list?part=liveStreamingDetails`) whether *this*
  broadcast has actually ended (`actualEndTime` present), and finalize only
  on that confirmation — not by inferring "ended" from ffmpeg's audio flow.
- Raw audio silence is kept only as a fallback, and only if the poller is
  itself inconclusive (no API key / API error), with a much longer window
  (≥10 min) than the old default — its job is catching a genuinely orphaned
  process, not reacting to short blips.

**Why this solves today's incident specifically:** the 403 storm lasted 71
seconds. A 30-minute floor means today's exact failure would never have
reached a finalize decision at all — ffmpeg (or a future retry mechanism)
would have had the rest of the floor window to recover.

**What it does *not* solve:** if the underlying CDN/session issue doesn't
self-heal within 30 minutes, the capture still eventually ends with a short
transcript — just later, and via a real "YouTube confirms this ended" signal
instead of a false one. It buys time for recovery; it doesn't manufacture a
connection that stays broken.

**Status:** written, `tsc`-clean, **not committed or deployed.**

---

## 3. Item 2 — Alerting on short/failed captures

**Where:** extend the existing publish-chain step
(`src/lib/sermon-publish-chain.ts`, invoked from
`POST /api/sermon-captures/[id]/publish-chain`), which already runs at
exactly the right moment — right after a capture finalizes, before it
returns `outcome`.

**Mechanism:**
- After computing `outcome` (already one of `published`, `draft`,
  `draft-no-summary`, etc.), check two conditions: `outcome ===
  'draft-no-summary'` OR `transcriptChars` below a threshold (e.g. 2000 —
  roughly a minute of speech; today's was 129).
- If either is true, send an admin alert via the same WhatsApp channel
  already used for notetaker links (Meta API, already wired in
  `src/lib/notetaker.ts` / the portal's WA-send helper) — but to the admin
  distribution list, not the notetaker list. Message: service number, date,
  transcript char count, `endReason`, and a direct link to the capture's
  admin detail row.
- Best-effort, matching the existing pattern for all portal callbacks in
  this pipeline (`callPortal` in `live-summary.ts` is fire-and-forget or
  awaited-but-non-fatal) — an alert failure must never block or fail the
  publish chain itself.

**Why here and not a new hook from the Cloud Run Job:** the job already
calls `publish-chain` unconditionally at the end of every capture (Hook 2),
and `publish-chain` already computes the exact signals needed
(`transcriptChars`, `outcome`). Adding the check here means zero new
calls between the job and the portal — one hook does double duty instead of
adding a third.

**Why this matters even with Item 1 deployed:** Item 1 reduces how often a
short capture happens; it doesn't reduce it to zero (the >30-min-unrecovered
case, or an entirely different failure class next time). Item 2 is the
backstop that makes sure a short capture is never silently invisible again.

**Data model change:** none — `transcriptChars` and `outcome` already exist
on `sermon_captures/{docId}`.

---

## 4. Item 3 — Manual re-run trigger

**Where:** new admin action button on `/admin/khotbah` (same card-action
pattern as the existing "Stop & Summarize" / "Regenerate Summary" buttons),
backed by a new route `POST /api/sermon-captures/[id]/rerun`.

**Mechanism:**
- **Gated to a valid time window — two layers, cheap check first:**
  1. *Render-time (client, no API call):* the button only appears active
     when `now` falls inside `[capture.startedAt, capture.startedAt +
     MAX_SERVICE_WINDOW_MS]`, where `MAX_SERVICE_WINDOW_MS` is a generous
     ceiling well past the normal ~90-minute service (e.g. 3 hours, to
     cover a service that runs long). Outside that window — including any
     capture from a previous day — the button renders disabled with a
     tooltip ("layanan ini kemungkinan sudah selesai — re-run tidak akan
     mendapat lebih banyak konten"). This is a pure timestamp comparison,
     computed from `capture.startedAt` already on the doc; no network call
     needed just to decide whether to show an enabled button.
  2. *Click-time (server, authoritative):* the time window is only a
     heuristic — a service can end early or occasionally run past the
     ceiling. So before the route actually calls the Cloud Run Jobs API, it
     re-checks `liveStreamingDetails.actualEndTime` for the doc's `videoId`
     via the YouTube Data API. If `actualEndTime` is present (broadcast has
     genuinely ended), the route refuses with 409 even if the client-side
     window said the button should be active — the time check is an
     optimistic UI gate, the API check is the real guard against wasting a
     Cloud Run execution and Gemini cost on a dead broadcast.
  If the broadcast has already ended by either check, re-running can't
  recover more than a fresh capture could — see §6 for why post-hoc re-runs
  don't help.
- On click, the route calls the **Cloud Run Jobs API**
  (`POST .../v1/namespaces/{project}/jobs/{job}:run`, the same v1 shape
  deploy.sh's own Cloud Scheduler entries use) to start a new execution of
  `gbi-bec-youtube-live-sync`, with a `TARGET_VIDEO_ID` env-var override that
  skips discovery entirely and captures the *known* `videoId` directly.
  This required a small backend addition (`sunday-runner.ts@41d9d6d`) — the
  original plan was to reuse `FAKE_LIVE_NOW`, but reading the code showed
  that mechanism only fires in the ALL-DAY polling branch of `main()`, which
  the deployed job never takes (the Cloud Scheduler always sets
  `SERVICE_NUMBER`, forcing the `singleServiceMode` branch, which had no
  direct-videoId override until `TARGET_VIDEO_ID` was added). Caught by
  reading the code before building the portal side around a false
  assumption, not by testing it live first.
- Because `sermon_captures` docIds are deterministic
  (`{date}-service-{N}-{videoId}`, see `computeIdentity()`), the new
  execution naturally overwrites the same Firestore doc and GCS paths — no
  duplicate records, no merge logic needed. The re-run's transcript replaces
  the short one; whatever notetaker-link WhatsApp message already went out
  is not re-sent (Hook 1 only ever fires once per doc — same identity, so
  the "already capturing" guard on the notify-notetaker endpoint holds).
- Auth: `verifyAuthToken` (admin-only — this spends Gemini/Cloud Run cost
  and re-messages nothing, but it's an operational action, not a public one).

**Why this matters:** it's the only one of the four that can actually
recover *more* of a sermon than was originally captured — but only if
someone acts while the broadcast is still running. This is precisely why
it's paired with Item 2: an alert that arrives 5 minutes into a 90-minute
service, with 85 minutes still to go, makes the re-run button genuinely
useful. An alert that arrives after the fact (today's case) does not — see
§6 for why this doesn't help post-hoc.

**IAM:** turned out to need nothing new here either, same pattern as Item 4 —
the service account's existing `roles/editor` already covers `run.jobs.run`.
Verified directly: the first live trigger call succeeded on the first try,
no permission error. (The thing that *did* go wrong on that first live test
was unrelated to IAM — see below.)

**Status:** implemented and deployed on both sides. Tested live against the
real deployed job — with one mistake made and caught along the way, worth
recording plainly: the backend (`TARGET_VIDEO_ID`) was tested locally via
`tsx` and worked, then the portal trigger route was built and live-tested
directly against the real Cloud Run job — without redeploying the engine
first. That first live test silently ran against the *old* image (predating
`TARGET_VIDEO_ID`), fell through to normal discovery, and started polling
for a nonexistent service every 60 seconds — it would have burned a full
30 minutes of real compute had the logs not been checked directly instead
of assuming success from "the API call returned 200." Cancelled via
`gcloud run jobs executions delete`, confirmed nothing left running,
redeployed with the current code, reran the test: `TARGET_VIDEO_ID` mode
fired correctly, discovery was skipped, and the container exited cleanly.
(That second run's actual capture failed for an unrelated, pre-existing
reason — a yt-dlp bot-detection error on that specific proxy/cookie
combination — but the orchestrator handled the failure correctly: marked
the service `failed`, logged it, exited with no hang. The re-run mechanism
itself is what was under test, and it passed.)

---

## 5. Item 4 — On-demand execution log viewer

**Where:** new panel on the capture's expanded detail row in
`/admin/khotbah` ("View Cloud Run Logs" toggle, same expand pattern already
used for the transcript/summary tabs), backed by a new route
`GET /api/sermon-captures/[id]/logs`.

**Mechanism:**
- **Prerequisite change in `live-summary.ts`:** at Firestore registration
  time (where it currently writes `status: 'capturing'`), also write
  `cloudRunExecutionName: process.env.CLOUD_RUN_EXECUTION` — an env var
  Cloud Run auto-injects into every job execution. Without this, the portal
  has no way to know which execution's logs belong to a given capture.
- The route calls the **Cloud Logging API**
  (`entries.list`) filtered to
  `resource.type="cloud_run_job" AND resource.labels.job_name="gbi-bec-youtube-live-sync"
  AND labels."run.googleapis.com/execution_name"="<cloudRunExecutionName>"`,
  ordered ascending, windowed to 30 minutes **starting from the execution's
  own start time** (the capture doc's `capturedAt`), not from wall-clock
  "now." Anchoring to "now" was the original implementation and was wrong —
  caught by testing against a real day-old execution: it silently returned
  zero results, since incident review normally happens well after the
  30-minute mark from "now," not during it. Fixed and re-verified: 100/100
  entries correctly returned for that same execution once anchored to its
  actual start time.
- Explicitly **not** a live tail — one request, one snapshot, rendered as a
  read-only scrollable log panel. No websocket, no polling, no
  auto-refresh. Matches what was actually asked for: "a logger that would
  log everything happened past 30 mins of this cloud run," viewed on demand.
- Auth: `verifyAuthToken` (admin-only — raw logs can contain
  proxy credentials in URLs; the existing `live-summary.ts` logging already
  redacts credentials in its own console output, but the log *viewer*
  should not assume every historical line was written with that
  discipline — redact again server-side before returning to the client, by
  regexing the same patterns already used in `sunday-runner.ts`'s own
  redaction: `http:\/\/[^@]+@` → `http://<creds>@`).

**Why this matters:** every piece of root-cause analysis in this
investigation (the edge-handoff evidence, the 403 sequence, the "our own
logic didn't cause it" trace) came from `gcloud logging read`, run from a
terminal with `gcloud auth` access nobody but this session had. Without this
panel, diagnosing the *next* incident requires the same manual,
credentialed, CLI-based process — which is why it took this long to trace
today's. This closes that gap for whoever is on call, admin-authenticated,
no CLI required.

**IAM:** turned out to need nothing new. The service account already holds
`roles/editor` at the project level, and unlike Secret Manager (which Google
deliberately fences off even from Editor, confirmed via a real
`PERMISSION_DENIED` earlier in this investigation), Cloud Logging read access
is not similarly fenced — verified directly via the actual REST call this
code makes, authenticated as the real service account, no additional grant
needed. The original HLD draft assumed otherwise by analogy with the Secret
Manager case; that assumption was untested and wrong.

**Data model change:** `sermon_captures/{docId}.cloudRunExecutionName:
string`.

**Status:** implemented and deployed on both sides (`gbi-bec-youtube-live-sync`
writes the field; `gbi-bec-portal` serves the panel). Verified end-to-end
against a real production incident's logs.

---

## 6. Why post-hoc VOD recovery isn't a fifth item

Worth stating explicitly, since a large part of today's investigation went
into it: once a broadcast has actually ended, YouTube serves it through a
temporary, unstable pipeline (explicitly labeled `(Last 2 hours)` in format
listings) before the permanent VOD is ready. Every retry against that
pipeline during this incident plateaued at the same point (worship set,
never the sermon) regardless of format or client. This is a platform-side
processing delay, not something a re-run button, an alert, or a log viewer
can route around — which is exactly why Item 3's re-run button is designed
to be **disabled once the broadcast has ended**, rather than offered as a
false promise of recovery. The only two levers here remain: wait for
YouTube's processing to catch up, or fall back to the notetaker's manual
notes.

---

## 7. Rollout order (as planned, then as it actually went)

Planned: 1 → 2 → 4 → 3, on the theory that 4 (diagnosis) should land before
3 (an operationally sensitive action that spends real cost) so the two
IAM-gated items would prove out independently before combining.

As built: 1 → (2 found to already exist, no build needed) → 4 → 3, in that
order — matching the plan once 2 turned out to be a no-op. Both 3 and 4
turned out to need **no new IAM grants at all** (the assumed
`roles/logging.viewer` and `roles/run.developer` requirements were both
untested guesses, made by analogy with Secret Manager's real fencing —
`roles/editor` already covered both). That assumption was wrong in a way
that would have blocked nothing in practice, but it's worth remembering the
lesson generally: verify an IAM assumption against the actual call before
designing around it, rather than reasoning from a different service's
behavior.
