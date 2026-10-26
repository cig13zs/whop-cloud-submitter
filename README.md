# cloud-submitter

Publishes held campaign clips on YouTube at their slot and submits them to Content Rewards within 30 minutes, from
GitHub Actions, so it keeps working after the laptop is shut down for school. It runs the same rules as
`tools/whop_watch.py`: per-channel 5-minute GAP, the 30-minute window, campaign caps, and the Charisma Tape feed
backstop.

## Public repo, encrypted data (since 2026-10-20)

The private repo's 2,000 Actions minutes a month ran out on 10-20 (the laptop had dispatched ~100 runs a day). The repo
is now public, so minutes are free and unlimited. The old private repo, with its full history, is
`cig13zs/whop-cloud-submitter-archive` (workflow disabled), and there is also a bundle in `../_archive/`.
- `queue.json`, `state.json` and `laptop-state.json` exist only locally (gitignored). Git carries `*.json.enc`,
  encrypted with AES-256-GCM by `crypt.mjs`. The key is the `DATA_KEY` secret, with a laptop copy at
  `~/.claude/keys/whop-runner-data.key`.
- `whop_watch.py` decrypts after every pull and seals before every commit. The workflow decrypts first, then seals
  `state.json` back into `state.json.enc`.
- Logs are public, so `run.mjs` masks every clip, campaign, channel and post id (`::add-mask::`) before printing.
- Hardening:
  - no `pull_request` trigger, so forks never see the secrets;
  - only GitHub-owned actions, with checkout pinned by SHA;
  - read-only default token;
  - secret scanning with push protection;
  - the `protect-main` ruleset (no deletion, no force-push).
- Laptop on: `whop_watch.py` runs `run.mjs` locally (`refresh-session.mjs --local`, saves to `laptop-state.json`) instead
  of dispatching a GitHub run. The cron covers the laptop-off hours, every 10 min, all day.
- A clip the operator makes public by hand before its slot is submitted on the next run.
- `IG_TOKEN` is not set on the new repo. the operator adds it if Instagram API posting comes back (it must belong to
  `IG_USER`).

## How it works

| Piece | Where | Who writes it |
|---|---|---|
| `queue.json` (clips and their Manila slot) | this repo | the laptop only (`whop_watch.py add`, called by ytq and `schedule_flip.ps1`) |
| `state.json` (published / submitted / error per clip) | this repo | the runner only |
| `laptop-state.json` (clips the laptop fallback sent itself) | this repo | the laptop only |
| `run.mjs` | GitHub Actions, every 20 min 06:00-22:59 Manila | |
| `refresh-session.mjs` | laptop, daily task `\Creator\Whop Cloud Refresh` | pushes the secrets |

The repo is the single source of truth. The laptop pushes new entries and the cloud pulls them, because clips
are made on the laptop but have to go out while it is off. Each file has one writer, so `git pull --rebase` never
conflicts. With the flag on, the laptop's 5-minute pass only syncs git; it never publishes or submits, so the two
can't double-publish. While the laptop is on, that pass also starts the cloud run (`gh workflow run whop-submit`)
as soon as a clip is due and no run is already going. Clips then go out on time instead of waiting for GitHub's
cron, and the runner is still the only thing that publishes. If a held clip is 10+ minutes past its slot, still unpublished, and the latest cloud run since its slot failed or never started, the laptop publishes and submits it the old local way. It checks the Whop session first, logs `fallback-local <vid>: <reason>`, and records the result in `laptop-state.json` (laptop-only; the runner merges it and skips those clips).

Before it publishes anything, a run checks the Whop session. If the session is dead or Cloudflare blocks the
runner, the clips stay private and the run fails, and GitHub emails the failure. A clip never goes public with no
submit behind it.

### The Content Rewards submit (mapped 2026-09-30)

- "Submit clip" is a Next.js server action. It is `POST https://b4e0vdqv6zgqeqj4pfgm.apps.whop.com/c/exp_zeADOv9rOOKk2x/campaigns/<campaign id>` with these parts:
  - headers `Next-Action: <action id>`, `Accept: text/x-component` and `Content-Type: text/plain;charset=UTF-8`;
  - body `[{"campaignId":"<id>","url":"https://www.youtube.com/watch?v=<video id>"}]`.
- Submitting goes through the REST API, `POST /api/submission/submissions` with `{campaignId, url}` and the session cookie (since 2026-10-11, when Content Rewards removed `createSubmissionAction`). The session check still uses the `listMySubmissionsAction` server action, whose id changes with every deploy, so `run.mjs` finds it by name in the app's JS chunks on each run, in about 10 s.
- The reply is an RSC stream. Its `1:` line is `{"success":true,...}` or `{"code":...,"error":...,"success":false}`. A duplicate returns `CONFLICT` with `"kind":"duplicate-post"`. A dead session returns `UNAUTHORIZED`.
- Auth is two cookies of the app origin: `__Host-cr-session`, which lives 30 days, and `__Host-cr-whop-id`, the Whop user id. Every app launch mints a new session, and the older ones keep working.
- The REST API (`/api/submission/...`, including the submit) wants `__Host-cr-access-token`, which lives one day. The session cookie alone gets 401 `NOT_AUTHORIZED` (2026-10-12: lost wNuDu5f7u_I). Like the app's SessionRecovery, `rest()` answers a 401 by calling the `refreshSession` server action, merges its Set-Cookie headers into an in-memory cookie, and retries once. `--dry-run` logs `whop rest api: ok` when this works.

### TikTok and Instagram posts (added 2026-10-04)

`queue.json` also takes social entries, keyed `tt:<video id>` or `ig:<shortcode>`:
`{"campaign", "at" (Manila, when it went or goes live), "platform": "tiktok"|"instagram", "url", "clip" (YouTube id), "live": true}`.
The laptop's `tools/social-post/cross_post.py` posts the clip, reads it back off the public profile, then adds the
entry (`live: true`) with `whop_watch.cloud_add` and kicks a run. The runner submits the entry's own URL inside the
30-minute window. Without `live`, a TikTok entry waits for TikTok's oEmbed to answer 200, but from GitHub runners
it answered `HTTP 400 {"message":"Something went wrong","code":400}` for a live public video (2026-10-04, while the
laptop got 200), so scheduled TikTok posts going live with the laptop off can't be confirmed by the runner yet. The runner cannot discover a post URL
by itself: cookieless TikTok/Instagram profile pages carry no post list (tested 2026-10-04), and Content Rewards has
no "list my account's videos" action. Test from the runner: `gh workflow run whop-submit -f dry_run=true -f probe=<url>,<url>`.

### Instagram API queue (igs:)
The laptop's `ig_stage.py` copies Roblox MP4s to the private `ig-media` release and queues `igs:<slug>` with `mode: api`, `campaign`, Manila `at`, `asset`, `caption`, `slug`, and `yt`.
The runner stages containers from -40 min through +6 h, then publishes at/after the slot with a working Whop session, an open campaign and a 60-minute IG gap.
It saves the media id and permalink before submission, retries submission only inside 30 minutes, and deletes the release asset after the attempt.
`IG_TOKEN` must belong to `IG_USER`; `GH_TOKEN` downloads/deletes private assets. Refresh warnings fail the run; the operator replaces the secret himself.
`node run.mjs --dry-run` reads identity/quota and prints plans without creating, uploading, publishing, submitting or deleting media.
`ig_stage.py --dry-run` plans only; `--selftest` is offline. Normal staging is once per slug, 10/day, 06:30-22:30 Manila, 60 min apart, no later than YouTube +36 h.
Only `tools/social-post/ig_cloud.on` switches the laptop Instagram path; leave it absent until token and upload-contract checks pass.
Activation blocker (Meta docs, 2026-10-04, v26.0): resumable uploads are documented only for Facebook Login for Business; this brief requests Instagram Login. Resolve that mismatch before enabling.

## What is stored where

| Secret (GitHub Actions, this repo) | Content | Lifetime |
|---|---|---|
| `WHOP_CR_COOKIE` | `__Host-cr-session=…; __Host-cr-whop-id=…` | 30 days; renewed daily by the laptop task |
| `YT_CLIENT` | OAuth client id and secret (Desktop app) | until rotated in Google Cloud |
| `YT_REFRESH_TOKENS` | `{channel id: refresh token}` for the channels in `queue.json` only | until revoked (OAuth app In production; all channels re-consented 2026-10-07) |

Nothing else leaves the laptop. The whop.com login cookies, the Google passwords and the other channels' tokens
stay local. The local originals are `~\.claude\keys\youtube-oauth-client.json`, `~\.claude\keys\yt-tokens\<UC>.json`
and the agent-Chrome profile.

## Go-live

Run from `Whop-Clipping-Automation\cloud-submitter`:

1. `node selftest.mjs`. It must end with `selftest ok`.
2. `gh repo create whop-cloud-submitter --private --source . --push`
3. `node refresh-session.mjs --yt`, then run the Whop half under the lock:
   `& "..\..\..\tools\agent-chrome\with_locks.ps1" -Owner refresh-session -Locks cr -TimeoutSec 300 -NodeArgs @("$PWD\refresh-session.mjs")`
   This sets all three secrets over stdin.
4. `gh workflow run whop-submit -f dry_run=true`, then `gh run watch`. The log must show `whop session: ok` and `youtube <UC>: ok` for each channel.
5. Seed the queue: `python ..\tools\whop_watch.py cloud-in`
6. Switch on, in this order:
   - `gh variable set CLOUD_ON --body true` (the cron starts running jobs);
   - `New-Item ..\tools\whop-cloud.on` (the laptop stops publishing and submitting; `add` goes to the repo);
   - `Enable-ScheduledTask -TaskPath '\Creator\' -TaskName 'Whop Cloud Refresh'`.
7. After the first real slot, check that the clip is in `state.json` with `submitted` and in Content Rewards' submissions.

## Rollback

1. `gh variable set CLOUD_ON --body false`. The cron keeps firing but every job is skipped and bills nothing. To stop it outright, use `gh workflow disable whop-submit`.
2. `Remove-Item ..\tools\whop-cloud.on`, then `python ..\tools\whop_watch.py cloud-out`. This copies the queue, the publish stamps and the submissions back to the laptop files, and the laptop watcher takes over on its next pass.
3. `Disable-ScheduledTask -TaskPath '\Creator\' -TaskName 'Whop Cloud Refresh'`
4. Optional: `gh secret delete WHOP_CR_COOKIE` (and `YT_CLIENT`, `YT_REFRESH_TOKENS`). To kill a leaked session, sign out of Whop in agent Chrome and sign back in.

## Actions minutes

GitHub Free gives a private repo 2,000 minutes a month, and each job bills at least one minute. A pass takes about
10-20 s (the chunk lookup is about 10 s), so each run bills 1 minute.

| Schedule | Runs / month | Minutes |
|---|---|---|
| every 20 min, 06:00-22:59 Manila (chosen) | 51 × 31 = 1,581 | ~1,600 |
| every 10 min, all day (the brief's first ask) | 144 × 31 = 4,464 | over the free tier |
| every 10 min, 06:00-22:59 | 102 × 31 = 3,162 | over the free tier |

A clip goes public up to 20 minutes after its slot, plus GitHub's own cron delay (often 5-15 min at busy times). The
30-minute submit window is unaffected, because a held clip is published and submitted in the same run. A clip whose
slot is after 22:59 goes out at the 06:07 run.

## Risks

- **Cookie leak.** Anyone holding `WHOP_CR_COOKIE` can act as the operator inside Content Rewards for up to 30 days: submit clips, read submissions and earnings. It holds no password, no whop.com login and no payment method. Signing out of Whop kills it. GitHub encrypts secrets and masks them in logs; `run.mjs` never prints one.
- **YouTube token leak.** A leaked `YT_REFRESH_TOKENS` could edit the queued channels' videos until it is revoked at myaccount.google.com > Security > Third-party access.
- **Bot checks from datacenter IPs.** The app sits behind Cloudflare, with Sardine and hCaptcha on its pages. Plain `fetch` passed from the laptop; the dry run from GitHub's servers tests it from a datacenter. If a later run gets challenged, it fails before publishing anything, and GitHub emails the failure.
- **Content Rewards changes its app.** A renamed action, or a changed body or response shape, fails the run loudly. It never fails silently.
- **A YouTube token gets revoked** (password change, manual revoke). Laptop and cloud stop publishing for that channel; the run fails with `invalid_grant`. Re-consent with `node tools\ytapi\auth.mjs <UC>`, then `node refresh-session.mjs --yt`. The 7-day lapse ended 2026-10-07: the app is In production and every channel was re-consented that day; `refresh-session.mjs` still warns past 6 days for any older Testing-era token.
- **GitHub's cron is late to start and can skip slots.** On 2026-09-30 no scheduled run fired in the first 50 minutes after `CLOUD_ON` went on (the 08:47, 09:07 and 09:27 UTC slots were all skipped). Check `gh run list --workflow whop-submit --event schedule` the next morning. If scheduled runs still never appear, roll back to the laptop until they do.
- **Inactivity.** GitHub disables cron in a repo with no commits for 60 days. State commits count as activity, but a long gap with no clips needs a manual re-enable.

## Test

`node selftest.mjs` runs offline cases against fake `fetch`/`net.ig` adapters and prints its pass count: due, not due, gap, 30-minute expiry, a clip in
its window, YouTube refusing, a revoked YouTube token, Content Rewards refusing, a dead session or Cloudflare
challenge (nothing published), a session dying mid-run, a duplicate, the feed backstop, caps, and clips the laptop fallback already sent.
