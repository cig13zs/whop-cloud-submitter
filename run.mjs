#!/usr/bin/env node
// Cloud twin of Whop-Clipping-Automation/tools/whop_watch.py: publishes held campaign clips on YouTube at their slot
// and submits them to Content Rewards within 30 minutes of going public, from GitHub Actions, so it works while the
// laptop is off. queue.json is written only by the laptop (whop_watch.py add); state.json only by this runner.
//
//   node run.mjs              one pass (needs WHOP_CR_COOKIE, YT_CLIENT, YT_REFRESH_TOKENS)
//   node run.mjs --dry-run    checks the secrets with read-only calls, prints what it would publish and submit
//
// Never prints a cookie or token: errors carry HTTP statuses and API error codes only.
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const WINDOW = 30 * 60e3;   // Content Rewards takes a post only within 30 min of it going public
// A TikTok still "Content under review" is unreadable to Content Rewards ("We couldn't read that from the platform"); D27
// stayed unreadable for all 30 min on 2026-10-12, so Studio-scheduled TikTok entries keep retrying for 3 h.
export const TT_WINDOW = 3 * 3600e3;
export const GAP = 5 * 60e3;       // min time between two publishes on one channel ("just uplaod everything now", 2026-09-30)
const DEFAULTS = { UC1xCBrygVPEwmmzLxSN_zNg: '86842687-ba2b-4638-a024-995dcf3d25a3' }; // Charisma Tape -> Sartain, feed backstop
const USED_BEFORE = { '2c65001c-d6a8-4b14-9ba6-52400794b085': 5 }; // Alpha's 5 submissions made before any watcher
const ORIGIN = 'https://b4e0vdqv6zgqeqj4pfgm.apps.whop.com';
const PAGE = campaign => `${ORIGIN}/c/exp_zeADOv9rOOKk2x/campaigns/${campaign}`;
const YT = 'https://www.googleapis.com/youtube/v3/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
export const IG_VERSION = 'v26.0'; // Meta content-publishing/reference docs, checked 2026-10-04.
const IG = `https://graph.instagram.com/${IG_VERSION}/`;
const REPO = 'cig13zs/whop-cloud-submitter';
const IG_GAP = 60 * 60e3;

export const slot = at => Date.parse(at.replace(' ', 'T') + ':00+08:00'); // queue times are Manila wall clock
const iso = t => new Date(t).toISOString().replace('.000Z', 'Z');

// ---- YouTube ------------------------------------------------------------------------------------------------------
export async function feed(channel) {
  const xml = await (await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`, { headers: { 'user-agent': UA } })).text();
  return [...xml.matchAll(/<entry>[\s\S]*?<yt:videoId>([^<]+)<\/yt:videoId>[\s\S]*?<published>([^<]+)<\/published>/g)]
    .map(m => [m[1], Date.parse(m[2])]);
}

// Social entries (queue key tt:<id> / ig:<code>, with platform and url) are TikTok / Instagram posts of a clip.
export async function isPublic(vid, q = {}, now = Date.now()) { // oEmbed answers 401/403/404 while a video is private or scheduled
  // live: true = the laptop saw the post live before queueing it (its posting script reads the post off the profile).
  if (q.platform && q.live === true) return true;
  // TikTok's oEmbed answers 200 from the laptop, but from GitHub runners it answered HTTP 400 {"message":"Something
  // went wrong","code":400} for a live public video (2026-10-04), so a runner can't confirm a scheduled post went live.
  // scheduled: true = TikTok Studio's native schedule holds the post (id known at schedule time, 2026-10-12): trust
  // TikTok's servers to publish at the slot and submit from slot + 2 min when oEmbed won't answer.
  if (q.platform === 'tiktok') {
    const ok = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(q.url)}`, { headers: { 'user-agent': UA } }).then(r => r.ok, () => false);
    return ok || (q.scheduled === true && now >= slot(q.at) + 2 * 60e3);
  }
  // Instagram has no cookieless public check (oEmbed needs a Meta app token; profile/embed pages are login
  // walls from outside). Instagram entries are queued only once the laptop has seen the Reel live, so trust that.
  if (q.platform === 'instagram') return true;
  const channel = q.channel || q.source_channel;
  if (channel) return (await videoStatus(vid, channel)).privacyStatus === 'public';
  return (await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/shorts/${vid}`, { headers: { 'user-agent': UA } })).ok;
}

const access = {};
const publicTimes = {};
async function ytToken(channel) {
  if (access[channel]) return access[channel];
  const client = JSON.parse(process.env.YT_CLIENT || '{}');
  const refresh = JSON.parse(process.env.YT_REFRESH_TOKENS || '{}')[channel];
  if (!refresh) throw Object.assign(new Error(`no refresh token for ${channel} in YT_REFRESH_TOKENS (run refresh-session.mjs --yt)`), { fatal: true });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: refresh, grant_type: 'refresh_token' }) });
  const d = await r.json().catch(() => ({}));
  // d.error is a code such as invalid_grant: a Testing-mode OAuth app's refresh tokens lapse about 7 days after consent.
  if (!r.ok || !d.access_token) throw Object.assign(new Error(`YouTube token refresh for ${channel} failed: ${r.status} ${d.error || ''}`), { fatal: true });
  return (access[channel] = d.access_token);
}

export async function videoStatuses(ids, channel) {
  const r = await fetch(`${YT}videos?part=status,snippet&id=${encodeURIComponent(ids.join(','))}`, { headers: { authorization: `Bearer ${await ytToken(channel)}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`YouTube visibility: ${r.status} ${d.error?.errors?.[0]?.reason || ''}`);
  if (!Array.isArray(d.items)) throw new Error('YouTube visibility: missing items');
  for (const v of d.items) if (v.status?.privacyStatus === 'public' && v.snippet?.publishedAt) publicTimes[v.id] = v.snippet.publishedAt;
  return d.items;
}

async function videoStatus(vid, channel) {
  const status = (await videoStatuses([vid], channel)).find(v => v.id === vid)?.status;
  if (!status) throw new Error(`video ${vid} not found on ${channel}`);
  return status;
}

// Advisory reads may wait 15 minutes; due publication always uses fresh authenticated reads.
export async function readVisibility(queue, state, now, io) {
  const result = new Map(), groups = new Map();
  let cached = 0, requests = 0, exhausted;
  for (const [vid, q] of Object.entries(queue)) {
    const rec = state[vid], channel = q.channel || q.source_channel;
    if (!channel || (q.platform && q.platform !== 'youtube') || q.mode === 'api' || rec?.submitted || rec?.submission_terminal
      || (q.mode === 'monitor' && rec?.coverage_alert)
      || (rec?.published && now - Date.parse(rec.published) > WINDOW)) continue;
    const advisory = q.mode === 'monitor' || now < slot(q.at);
    const age = now - Date.parse(rec?.visibility?.checked_at || '');
    if (advisory && age >= 0 && age < 15 * 60000 && ['private', 'unlisted'].includes(rec?.visibility?.privacy_status)) {
      result.set(vid, { privacyStatus: rec.visibility.privacy_status }); cached++; continue;
    }
    if (!groups.has(channel)) groups.set(channel, []);
    groups.get(channel).push({ vid, q, advisory });
  }
  for (const [channel, entries] of groups) for (let i = 0; i < entries.length; i += 50) {
    const batch = entries.slice(i, i + 50);
    try {
      if (exhausted) throw exhausted;
      requests++;
      const rows = await net.videoStatuses(batch.map(x => x.vid), channel);
      for (const { vid, q, advisory } of batch) {
        const status = rows.find(v => v.id === vid)?.status;
        if (!status) { result.set(vid, { error: new Error(`video ${vid} not found on ${channel}`) }); continue; }
        result.set(vid, status);
        if (advisory && ['private', 'unlisted'].includes(status.privacyStatus) && !io.dry) {
          (state[vid] ??= { campaign: q.campaign }).visibility = { checked_at: iso(now), privacy_status: status.privacyStatus };
        }
      }
    } catch (error) {
      if (/quotaExceeded|dailyLimitExceeded/.test(error.message)) exhausted = error;
      for (const { vid } of batch) result.set(vid, { error });
    }
  }
  if (!io.dry && groups.size) io.save();
  io.log(`YouTube visibility: ${requests} batch requests, ${cached} cached advisory reads`);
  return result;
}

export async function publish(vid, channel) {
  const status = await videoStatus(vid, channel);
  const r = await fetch(`${YT}videos?part=status`, { method: 'PUT',
    headers: { authorization: `Bearer ${await ytToken(channel)}`, 'content-type': 'application/json' },
    // An omitted publishAt keeps a Studio schedule in place; only an explicit null drops it (ytapi, 2026-09-30).
    body: JSON.stringify({ id: vid, status: { ...status, privacyStatus: 'public', publishAt: null } }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`publish ${vid}: ${r.status} ${d.error?.errors?.[0]?.reason || ''}`);
  if (d.status?.privacyStatus === 'public') await videoStatus(vid, channel);
  return d.status?.privacyStatus === 'public'; // the PUT echo; a GET read-back lags (ytapi, 2026-09-30)
}

// ---- Content Rewards ----------------------------------------------------------------------------------------------
export async function cap(campaign) { // public API; paused or exhausted campaigns can't take a submit
  // The app origin serves the same public campaign API; contentrewards.com itself was down on 2026-10-20 while the app was up.
  const r = await fetch(`${ORIGIN}/api/campaign/campaigns/${campaign}`, { headers: { 'user-agent': UA } });
  const { data } = await r.json().catch(() => ({}));
  if (!data) throw new Error(`campaign ${campaign}: HTTP ${r.status}, no data`);
  if (data.status !== 'active') return 0;
  return data.configuration?.maxSubmissionsPerUser ?? null;
}

// "Submit clip" is a Next.js server action: a POST to the campaign page keyed by a build-specific action id. The id
// changes on every Content Rewards deploy, so it is looked up by name in the app's JS chunks on each run.
const actionIds = {};
export async function actionId(name) {
  if (actionIds[name]) return actionIds[name];
  const page = await fetch(PAGE(DEFAULTS.UC1xCBrygVPEwmmzLxSN_zNg), { headers: { 'user-agent': UA } });
  // A whole-site outage (Cloudflare 530 "Origin DNS error", 2026-10-20) read as "changed its app"; say what it is.
  if (!page.ok) throw Object.assign(new Error(`Content Rewards is down (HTTP ${page.status}); holding everything`), { fatal: true });
  const html = await page.text();
  const queue = [...html.matchAll(/\/c\/_next\/static\/chunks\/[\w.\-/]+?\.js/g)].map(m => m[0]), seen = new Set();
  while (queue.length && seen.size < 400) { // plain BFS over ~80 chunks (~10 s); cache ids if it gets slow
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const js = await (await fetch(ORIGIN + p, { headers: { 'user-agent': UA } })).text();
    for (const m of js.matchAll(/createServerReference\)\("([0-9a-f]{40,42})",[^)]{0,120}?"(\w+)"\)/g)) actionIds[m[2]] ??= m[1];
    if (actionIds[name]) return actionIds[name];
    for (const m of js.matchAll(/static\/chunks\/[\w.\-/]+?\.js/g)) queue.push('/c/_next/' + m[0]);
  }
  throw Object.assign(new Error(`server action ${name} not found in ${seen.size} chunks (Content Rewards changed its app)`), { fatal: true });
}

// Content Rewards' REST API reads a short-lived access cookie. In the browser a 401 runs the refreshSession server
// action (SessionRecovery), which sets fresh cookies, and the call is retried once; the runner does the same with an
// in-memory copy. ponytail: the refreshed cookie lives for one run only; the WHOP_CR_COOKIE secret is never rewritten.
let crCookie = null;
const cookie = () => crCookie ?? process.env.WHOP_CR_COOKIE ?? '';
export const mergeCookies = (jar, setCookies) => {
  const m = new Map(jar.split(/;\s*/).filter(Boolean).map(p => [p.split('=')[0], p]));
  for (const c of setCookies) { const p = c.split(';')[0]; m.set(p.split('=')[0], p); }
  return [...m.values()].join('; ');
};
async function refreshSession(campaign) {
  const r = await fetch(PAGE(campaign), { method: 'POST', redirect: 'manual', headers: {
    cookie: cookie(), 'user-agent': UA, accept: 'text/x-component', 'content-type': 'text/plain;charset=UTF-8',
    'next-action': await actionId('refreshSession'), origin: ORIGIN, referer: PAGE(campaign) }, body: '[]' });
  await r.text();
  const set = r.headers.getSetCookie?.() || [];
  if (set.length) crCookie = mergeCookies(cookie(), set);
  return set.length > 0;
}
async function rest(path, campaign, init = {}) {
  const go = () => fetch(ORIGIN + path, { redirect: 'manual', ...init, headers: { cookie: cookie(), 'user-agent': UA,
    accept: 'application/json', 'content-type': 'application/json', origin: ORIGIN, referer: PAGE(campaign) } });
  const r = await go();
  if (r.status !== 401) return r;
  const refreshed = await refreshSession(campaign);
  console.log(`rest ${path.split('?')[0]}: 401, refreshSession ${refreshed ? 'set fresh cookies, retrying' : 'set no cookies'}`);
  return refreshed ? go() : r;
}

async function action(name, campaign, args) {
  const r = await fetch(PAGE(campaign), { method: 'POST', redirect: 'manual', headers: {
    cookie: cookie(), 'user-agent': UA, accept: 'text/x-component', 'content-type': 'text/plain;charset=UTF-8',
    'next-action': await actionId(name), origin: ORIGIN, referer: PAGE(campaign) }, body: JSON.stringify(args) });
  const text = await r.text();
  if (r.headers.get('cf-mitigated') || r.status === 403) return { blocked: `HTTP ${r.status} ${r.headers.get('cf-mitigated') || ''}`.trim() };
  // The body is an RSC stream: "0:{...}\n1:{...,"success":bool}". Take the line that carries the action's result.
  const res = text.split('\n').map(l => { try { return JSON.parse(l.slice(l.indexOf(':') + 1)); } catch { return null; } })
    .find(o => o && typeof o === 'object' && 'success' in o);
  return res || { blocked: `HTTP ${r.status}, no action result` };
}

// On 2026-10-11 Content Rewards dropped createSubmissionAction: the app now calls its REST API
// (submissionClient.createSubmission = POST /api/submission/submissions, body {campaignId, url}, same session cookie,
// reply {success, data} or {success:false, error:{code, message}}). A fixed REST path doesn't change per deploy.
export async function submit(vid, campaign, url = `https://www.youtube.com/watch?v=${vid}`) {
  const r = await rest('/api/submission/submissions', campaign, { method: 'POST', body: JSON.stringify({ campaignId: campaign, url }) });
  const res = await r.json().catch(() => null);
  if (r.headers.get('cf-mitigated') || !res) return { stage: 'blocked', error: `HTTP ${r.status} ${r.headers.get('cf-mitigated') || 'no JSON'}` };
  if (res.success) return { stage: 'submitted', ...(res.data?.id ? { receipt: { receipt_id: res.data.id,
    campaign_id: campaign, post_url: url, submitted_at: res.data.createdAt || null,
    status: res.data.status || null, review_status: res.data.reviewStatus || null } } : {}) };
  const { code, message } = res.error || {};
  if (/DUPLICATE/.test(code) || /already (?:been )?submitted/i.test(message)) return { stage: 'submitted', note: 'duplicate' }; // already in, e.g. by the laptop
  return { stage: r.status === 401 || /AUTHORIZED/.test(code) ? 'unauthorized' : 'refused', error: `${code}: ${message}` };
}

export async function readReceipts() {
  const rows = [], seen = new Set();
  let cursor;
  for (let page = 0; page < 20; page++) {
    const r = await rest('/api/submission/submissions?limit=100&creatorView=true' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), DEFAULTS.UC1xCBrygVPEwmmzLxSN_zNg);
    const data = await r.json().catch(() => null);
    if (!r.ok || data?.success !== true || !Array.isArray(data.data)) throw new Error(`receipt read failed: HTTP ${r.status}`);
    rows.push(...data.data);
    cursor = data.pagination?.nextCursor;
    if (!cursor) return rows;
    if (seen.has(cursor)) throw new Error('receipt pagination repeated a cursor');
    seen.add(cursor);
  }
  throw new Error('receipt pagination exceeded 20 pages');
}

export function reconcileReceipts(queue, state, rows) {
  let changed = 0;
  for (const r of rows) {
    const post = r.socialMediaPost;
    const vid = post?.platform && post.platform !== 'youtube' ? socialEntry(post.postUrl || '')?.key : post?.postId;
    if (!vid || !r.campaignId || !r.id || !r.createdAt) continue;
    const q = queue[vid];
    const channel = q?.channel || q?.source_channel || state[vid]?.source_channel;
    if ((q && r.campaignId !== q.campaign) || (channel && post.authorId !== channel)
      || (!q && state[vid]?.campaign && state[vid].campaign !== r.campaignId)) continue;
    const rec = state[vid] ??= { campaign: r.campaignId, ...(!q ? { receipt_only: true } : {}) };
    rec.campaign ??= r.campaignId;
    if (rec.whop_receipt?.receipt_id === r.id && rec.whop_receipt?.status === r.status && rec.whop_receipt?.review_status === r.reviewStatus
      && rec.whop_receipt?.author_channel_id === post.authorId && !rec.error) continue;
    if (rec.error) rec.previous_error = rec.error;
    delete rec.error;
    delete rec.submission_terminal;
    rec.submitted = r.createdAt;
    rec.whop_receipt = { receipt_id: r.id, campaign_id: r.campaignId, post_url: r.socialMediaPost.postUrl,
      author_channel_id: r.socialMediaPost.authorId, submitted_at: r.createdAt, status: r.status, review_status: r.reviewStatus };
    changed++;
  }
  return changed;
}

export async function discoverUnregistered(queue, state, now, io) {
  const channels = [...new Set(Object.values(queue).map(q => q.channel || q.source_channel).filter(Boolean))];
  let added = 0;
  await Promise.all(channels.map(async channel => {
    try {
      for (const [vid, at] of await net.feed(channel)) {
        if (queue[vid] || state[vid]?.submitted || state[vid]?.unmapped_public_at || now < at || now - at > 24 * 3600e3) continue;
        state[vid] = { ...state[vid], source_channel: channel, unmapped_public_at: iso(at), coverage_alert: iso(now) };
        added++;
      }
    } catch (e) { io.log(`upload coverage feed read failed: ${e.message}`); }
  }));
  if (added) { io.save(); io.log(`detected ${added} public uploads outside the submission queue`); io.fatal.push('Unregistered public uploads need exact campaign/source/review records; no publish or submit permission inferred'); }
  return added;
}

// Content Rewards dropped listMySubmissionsAction (~10-21), which held every clip as "session dead". The session check
// now goes through the same REST API submit() uses, so it can only fail when submitting would fail too.
export async function whopCheck() { // read-only: does WHOP_CR_COOKIE still open the app?
  const r = await restCheck();
  return r.startsWith('ok') ? 'ok' : r;
}
export async function restCheck(campaign = DEFAULTS.UC1xCBrygVPEwmmzLxSN_zNg) { // read-only: does the REST API that submit() uses accept the session (after a refresh)?
  const r = await rest('/api/submission/appeals/standing', campaign);
  // No query params, so an accepted session answers 422 VALIDATION; only 401/403 mean the auth failed.
  if (r.headers.get('cf-mitigated')) return `blocked (HTTP ${r.status} ${r.headers.get('cf-mitigated')})`;
  return r.status === 401 || r.status === 403 ? `HTTP ${r.status} ${(await r.json().catch(() => ({}))).error?.code || ''}`.trim() : `ok (HTTP ${r.status})`;
}

// ---- Instagram Login ----------------------------------------------------------------------------------------------
const redactIG = value => String(value).split(process.env.IG_TOKEN || '\0').join('[redacted]')
  .split(encodeURIComponent(process.env.IG_TOKEN || '\0')).join('[redacted]');

async function igRequest(url, options = {}) {
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(120_000), ...options }); }
  catch { throw new Error('instagram HTTP unavailable'); } // never echo a URL, header, token or fetch cause
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw Object.assign(new Error(`instagram HTTP ${r.status}: ${d.error?.code ?? ''}/${d.error?.error_subcode ?? ''} ${redactIG(d.error?.message || '')}`.trim()), { fatal: true });
  return d;
}

const igGet = (edge, fields) => igRequest(IG + edge + (fields ? `?fields=${encodeURIComponent(fields)}` : ''),
  { headers: { authorization: `Bearer ${process.env.IG_TOKEN}` } });
const igPost = (edge, fields) => igRequest(IG + edge, { method: 'POST',
  headers: { authorization: `Bearer ${process.env.IG_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
function igAsset(asset) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.mp4$/.test(asset)) throw new Error('invalid Instagram asset name');
  return asset;
}
function igRelease(args) {
  try { return execFileSync('gh', ['release', ...args, '--repo', REPO], { env: process.env, windowsHide: true, stdio: 'pipe', timeout: 120_000 }); }
  catch (e) { throw new Error(`gh release ${args[0]} failed (exit ${e.status ?? 'timeout'})`); }
}

export const net = { feed, isPublic, videoStatuses, cap, publish, submit, whopCheck, ig: {
  me: () => igGet('me', 'user_id,username'),
  // Instagram Login takes Reels only by video_url: upload_type=resumable answered "The parameter video_url is
  // required" (probe run 37201477081, 2026-10-04). Meta fetches the file itself from link() below.
  create: (id, caption, videoUrl) => igPost(`${id}/media`, { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true' }),
  // A short-lived signed download URL for a private ig-media asset (the API's octet-stream redirect), never stored.
  // the signed URL lives ~5 min and Meta fetches on create; host the files publicly if fetches start failing.
  link: async asset => {
    let rel;
    try { rel = JSON.parse(execFileSync('gh', ['api', `repos/${REPO}/releases/tags/ig-media`], { env: process.env, windowsHide: true, stdio: 'pipe', timeout: 60_000 })); }
    catch (e) { throw new Error(`gh api ig-media failed (exit ${e.status ?? 'timeout'})`); }
    const a = rel.assets?.find(x => x.name === igAsset(asset));
    if (!a) throw new Error(`asset ${asset} is not in ig-media`);
    const r = await fetch(a.url, { redirect: 'manual', headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/octet-stream' } });
    const loc = r.headers.get('location');
    if (!loc) throw new Error(`asset link for ${asset}: HTTP ${r.status}`);
    return loc;
  },
  status: id => igGet(id, 'status_code'),
  publish: (id, container) => igPost(`${id}/media_publish`, { creation_id: container }),
  permalink: id => igGet(id, 'permalink,shortcode'),
  limit: id => igGet(`${id}/content_publishing_limit`, 'quota_usage,config'),
  refresh: () => igRequest(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: process.env.IG_TOKEN })}`),
  download: (asset, tmp) => { igRelease(['download', 'ig-media', '--pattern', igAsset(asset), '--dir', tmp]); return path.join(tmp, asset); },
  deleteAsset: asset => igRelease(['delete-asset', 'ig-media', igAsset(asset), '-y']),
} };

// Queue key and fields for a TikTok / Instagram post URL (the laptop's cross_post.py writes the same shape).
export function socialEntry(url) {
  let m = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
  if (m) return { key: `tt:${m[1]}`, platform: 'tiktok', url: url.split('?')[0] };
  m = url.match(/instagram\.com\/(?:[^/]+\/)?(reel|p)\/([\w-]+)/);
  if (m) return { key: `ig:${m[2]}`, platform: 'instagram', url: `https://www.instagram.com/${m[1]}/${m[2]}/` };
  return null;
}

// ---- planning (same rules as whop_watch.py) -------------------------------------------------------------------
// Can this campaign take one more submit? Looked up once per campaign per run. A failed lookup counts as closed:
// holding costs one 15-minute run, while publishing into a paused campaign loses the clip (AftPinWeR88, TV Pilot #3
// paused, one bad lookup on 2026-10-14 12:15Z published it after 12 days held).
async function open(campaign, state, io) {
  io.caps ??= {};
  if (!(campaign in io.caps)) {
    let limit;
    try { limit = await net.cap(campaign); } catch (e) { io.log(`cap lookup ${campaign} failed (${e.message}): holding its clips, retry next run`); return io.caps[campaign] = false; }
    const used = (USED_BEFORE[campaign] || 0) + Object.values(state).filter(r => r.campaign === campaign && r.submitted).length;
    io.caps[campaign] = limit == null || used < limit;
    if (!io.caps[campaign]) io.log(`holding ${campaign} clips private: campaign paused or at its cap (${used}/${limit})`);
  }
  return io.caps[campaign];
}

export async function candidates(queue, state, now, io) {
  const out = new Map(); // vid -> [campaign, public since]
  const visibility = await readVisibility(queue, state, now, io);
  const visibleNow = async (vid, q) => {
    const status = visibility.get(vid);
    if (!status) return net.isPublic(vid, q, now);
    if (status.error) throw status.error;
    return status.privacyStatus === 'public';
  };
  for (const [channel, campaign] of Object.entries(DEFAULTS)) {
    try { for (const [vid, t] of await net.feed(channel)) if (now - t <= WINDOW) out.set(vid, [campaign, t]); }
    catch (e) { io.log(`feed ${channel}: ${e.message}`); } // a feed hiccup mustn't stop the queued videos
  }
  const pub = vid => state[vid]?.published || queue[vid].published;
  const last = {}; // latest publish per channel, for GAP: after a long outage held clips go out one per channel per GAP
  for (const [vid, q] of Object.entries(queue)) if (q.channel && pub(vid)) last[q.channel] = Math.max(last[q.channel] || 0, Date.parse(pub(vid)));
  const rules = Object.fromEntries(Object.values(queue).filter(q => q.channel && (q.min_gap_minutes || q.max_posts_per_manila_day)).map(q => [q.channel, q]));
  const postingTime = r => Date.parse(r.released_at || r.published || r.whop_receipt?.submitted_at || '');
  const author = (vid, r) => queue[vid]?.channel || queue[vid]?.source_channel || r.whop_receipt?.author_channel_id;
  const manilaDay = t => new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
  for (const [vid, r] of Object.entries(state)) if (rules[author(vid, r)] && Number.isFinite(postingTime(r))) { const ch = author(vid, r); last[ch] = Math.max(last[ch] || 0, postingTime(r)); }
  for (const [vid, q] of Object.entries(queue).sort((a, b) => a[1].at.localeCompare(b[1].at))) {
    if (state[vid]?.submitted || state[vid]?.submission_terminal) { out.delete(vid); continue; }
    if (q.mode === 'monitor') {
      out.delete(vid);
      if (state[vid]?.coverage_alert) continue;
      let visible = false;
      try { visible = await visibleNow(vid, q); }
      catch (e) { if (!state[vid]?.coverage_error) { (state[vid] ??= { campaign: q.campaign }).coverage_error = iso(now); io.save(); io.fatal.push(`monitored clip ${vid} cannot verify visibility: ${e.message}`); } }
      if (visible && !state[vid]?.coverage_alert) {
        (state[vid] ??= { campaign: q.campaign }).coverage_alert = iso(now);
        io.save();
        io.fatal.push(`public monitored clip ${vid} needs release checks and receipt reconciliation; never republish`);
      }
      continue;
    }
    if (q.mode === 'api') { out.delete(vid); continue; }
    if (out.has(vid)) continue;
    const at = slot(q.at);
    // A held clip can be made public manually before its slot. Detect its actual public time and submit.
    let visible = false;
    if (q.channel && !pub(vid)) {
      try { visible = await visibleNow(vid, q); }
      catch (e) { io.log(`visibility read ${vid} failed: ${e.message}`); io.fatal.push(`${vid}: ${e.message}`); continue; }
    }
    if (q.channel && !pub(vid) && visible) {
      const since = publicTimes[vid] ? Date.parse(publicTimes[vid]) : now;
      (state[vid] ??= { campaign: q.campaign }).published = iso(since);
      io.save();
      io.log(`detected existing public video ${vid} (slot ${q.at})`);
      last[q.channel] = since;
      if (now - since <= WINDOW) out.set(vid, [q.campaign, since]);
      continue;
    }
    if (q.channel && !pub(vid) && now >= at) {
      const rule = rules[q.channel] || {};
      const gap = rule.min_gap_minutes ? rule.min_gap_minutes * 60000 : GAP;
      if (last[q.channel] && now - last[q.channel] < gap) continue;
      if (rule.max_posts_per_manila_day && Object.entries(state).filter(([id, r]) => author(id, r) === q.channel
        && Number.isFinite(postingTime(r)) && manilaDay(postingTime(r)) === manilaDay(now)).length >= rule.max_posts_per_manila_day) continue;
      // A paused or capped campaign can't take the submit, so publishing would burn the clip's 30-minute window for
      // nothing (TIyZahZmFZE, TV Pilot #1 paused, 2026-10-02). Keep it private until the campaign reopens.
      if (!(await open(q.campaign, state, io))) continue;
      // Never make a clip public that can't be submitted: check the Whop session once per run before publishing.
      io.whop ??= await net.whopCheck().catch(e => e.message);
      if (io.whop !== 'ok') {
        if (!io.fatal.some(f => f.startsWith('whop session'))) { io.fatal.push(`whop session: ${io.whop}; nothing published`); io.log(`whop session ${io.whop}: holding ${vid}`); }
        continue;
      }
      let ok = false;
      try { ok = await net.publish(vid, q.channel); }
      catch (e) { io.log(`publish ${vid} failed: ${e.message}`); if (e.fatal) io.fatal.push(e.message); }
      if (ok) {
        const since = publicTimes[vid] ? Date.parse(publicTimes[vid]) : now;
        last[q.channel] = since;
        const rec = state[vid] ??= { campaign: q.campaign };
        rec.published = iso(since);
        rec.released_at = iso(now);
        io.save(); // before the submit, so a crash can't lead to a second publish with a fresh window
        io.log(`published ${vid} (slot ${q.at})`);
        if (now - since <= WINDOW) out.set(vid, [q.campaign, since]);
        else { rec.submission_terminal = 'YouTube first-public timestamp predates the submission window'; io.save(); io.fatal.push(`${vid}: first-public timestamp already outside the submission window; never reupload`); }
      }
      continue;
    }
    const since = pub(vid) ? Date.parse(pub(vid)) : at;
    if (now - since >= -2 * 60e3 && now - since <= (q.platform === 'tiktok' && q.scheduled === true ? TT_WINDOW : WINDOW) && !state[vid]?.submitted && !state[vid]?.submission_terminal && await visibleNow(vid, q)) out.set(vid, [q.campaign, since]);
  }
  return out;
}

export async function plan(queue, state, now, io) {
  const used = {}, todo = [];
  for (const r of Object.values(state)) if (r.submitted) used[r.campaign] = (used[r.campaign] || 0) + 1;
  const found = [...(await candidates(queue, state, now, io))].sort((a, b) => a[1][1] - b[1][1]);
  for (const [vid, [campaign, since]] of found) {
    if (state[vid]?.submitted || state[vid]?.submission_terminal) continue;
    let limit;
    try { limit = await net.cap(campaign); } catch (e) { io.log(`skip ${vid}: cap lookup failed (${e.message}), retry next run`); continue; }
    const n = (USED_BEFORE[campaign] || 0) + (used[campaign] || 0);
    if (limit != null && n >= limit) { io.log(`skip ${vid}: ${campaign} is at its cap (${n}/${limit})`); continue; }
    used[campaign] = (used[campaign] || 0) + 1;
    todo.push([vid, campaign, since]);
  }
  return todo;
}

export async function pass(queue, state, now, io) {
  for (const [vid, campaign, since] of await plan(queue, state, now, io)) {
    const age = Math.floor((now - since) / 60e3);
    let res;
    // Content Rewards refused "Unable to confirm the post's publish time" ~20 s after publish on 10-13, 10-14 and 10-16; each
    // went in on the next cron run, 10-15 min later. Retry in this run instead so the 30-min window isn't eaten.
    for (let i = 0; i < 3; i++) {
      if (i) { io.log(`${vid}: publish time not visible to Content Rewards yet, retrying in 60 s`); await (io.wait || (ms => new Promise(r => setTimeout(r, ms))))(60e3); }
      try { res = queue[vid]?.url ? await net.submit(vid, campaign, queue[vid].url) : await net.submit(vid, campaign); } catch (e) { res = { stage: 'error', error: e.message }; if (e.fatal) io.fatal.push(e.message); }
      if (!(res.stage === 'refused' && /confirm the post's publish time/i.test(res.error))) break;
    }
    io.log(`${vid} -> ${campaign}: ${res.stage}${res.note ? ` (${res.note})` : ''}${res.error ? ` ${res.error}` : ''} (public ${age} min)`);
    const rec = (state[vid] ??= { campaign });
    if (res.stage === 'submitted') { rec.submitted = iso(Date.now()); delete rec.error; if (res.note) rec.note = res.note; if (res.receipt) rec.whop_receipt = res.receipt; }
    else { rec.error = `${res.stage}: ${res.error || ''}`.trim(); if (['unauthorized', 'blocked'].includes(res.stage)) io.fatal.push(`${vid}: ${rec.error}`); }
    if (res.stage === 'refused' && /within 30 minutes|past (?:that |the )?window/i.test(res.error || '')) {
      rec.submission_terminal = 'Whop refused the posting-time window';
      io.fatal.push(`${vid}: Whop refused the posting-time window; preserve the public video and reconcile its first-public time`);
    }
    // D27 (10-12) and heje3041 (10-20): a TikTok CR can't read at 30 min stayed unreadable for the whole 3-h window while
    // oEmbed said public. Fail the run once so GitHub emails while there is still time to repost it directly.
    if (queue[vid]?.platform === 'tiktok' && /couldn't read/i.test(res.error || '') && age >= 30 && !rec.alerted) {
      rec.alerted = iso(Date.now());
      io.fatal.push(`${vid}: Content Rewards still can't read this TikTok after ${age} min; repost it directly (${queue[vid].url})`);
    }
    io.save();
  }
}

export async function igPass(queue, state, now, io) {
  const entries = Object.entries(queue).filter(([key, q]) => key.startsWith('igs:') && q.mode === 'api')
    .sort((a, b) => a[1].at.localeCompare(b[1].at));
  if (!process.env.IG_TOKEN) { io.log(`instagram api: IG_TOKEN not set, skipping ${entries.length} entries`); return; }
  io.igUser ??= await net.ig.me();
  const igUser = process.env.IG_USER;
  if (igUser && io.igUser.username !== igUser) throw new Error(`IG_TOKEN is for ${redactIG(io.igUser.username)}, not the configured IG_USER`);
  const id = io.igUser.user_id;
  if (!id) throw new Error('instagram: user_id missing');
  if (io.dry) {
    const limit = (await net.ig.limit(id)).data?.[0];
    io.log(`instagram api: user ${io.igUser.username}, publishing limit ${limit?.quota_usage ?? 'unknown'}/${limit?.config?.quota_total ?? 'unknown'}`);
  }
  // Token age: a refresh returns a *new* token (the old one keeps its own 60-day expiry), so comparing it to IG_TOKEN
  // always failed (2026-10-04). Track when this token (by hash, never the value) was first seen and warn from day 50.
  // the runner can't rewrite its own secret; upgrade path is a PAT secret plus the secrets API.
  const hash = createHash('sha256').update(process.env.IG_TOKEN).digest('hex').slice(0, 12);
  if (state._igtoken?.hash !== hash && !io.dry) { state._igtoken = { hash, since: iso(now) }; io.save(); }
  const age = (now - Date.parse(state._igtoken?.since || iso(now))) / 864e5;
  if (age >= 50) io.fatal.push(`IG token is ${Math.floor(age)} days old (Instagram tokens last 60): rerun \`gh secret set IG_TOKEN\` with a fresh one`);
  let last = Math.max(0, ...Object.entries(state).filter(([key, r]) => key.startsWith('igs:') && r.published).map(([, r]) => Date.parse(r.published)));
  for (const [key, q] of entries) {
    const rec = io.dry ? { ...(state[key] || { campaign: q.campaign }) } : (state[key] ??= { campaign: q.campaign });
    if (rec.submitted || rec.failed) continue;
    const at = slot(q.at);
    if (!Number.isFinite(at)) { io.fatal.push(`${key}: invalid slot`); continue; }
    try {
      if (!rec.container && !rec.published && now >= at - 40 * 60e3 && now <= at + 6 * 60 * 60e3 && await open(q.campaign, state, io)) {
        if (io.dry) io.log(`would stage ${key} (${q.asset}, slot ${q.at})`);
        else {
          const container = await net.ig.create(id, q.caption, await net.ig.link(q.asset));
          if (!container.id) throw new Error('instagram: create returned no id');
          rec.container = container.id;
          rec.staged = iso(now);
          io.save();
          io.log(`staged ${key}: container ${rec.container}`);
        }
      }
      if (!rec.published && (rec.container || io.dry && now <= at + 6 * 60 * 60e3) && now >= at) {
        if (!(await open(q.campaign, state, io))) continue;
        io.whop ??= await net.whopCheck().catch(e => e.message);
        if (io.whop !== 'ok') {
          if (!io.fatal.some(f => f.startsWith('whop session'))) io.fatal.push(`whop session: ${io.whop}; nothing published`);
          io.log(`whop session ${io.whop}: holding ${key}`);
          continue;
        }
        if (now - last < IG_GAP) { io.log(`instagram gap: holding ${key}`); continue; }
        if (io.dry) { io.log(`would publish ${key} (slot ${q.at})`); last = now; continue; }
        const { status_code: status } = await net.ig.status(rec.container);
        if (status === 'IN_PROGRESS') { io.log(`${key}: IN_PROGRESS; wait for next run`); continue; }
        if (rec.publishing || status === 'PUBLISHED') {
          io.fatal.push(`${key}: publish outcome needs reconciliation; container ${rec.container}; refusing another publish`);
          continue;
        }
        if (status === 'ERROR' || status === 'EXPIRED') {
          delete rec.container;
          rec.tries = (rec.tries || 0) + 1;
          if (rec.tries >= 3) { rec.failed = status; io.fatal.push(`${key}: ${status} after ${rec.tries} tries`); }
          io.save(); io.log(`${key}: ${status}, try ${rec.tries}/3`); continue;
        }
        if (status !== 'FINISHED') throw new Error(`instagram: unknown container status ${status}`);
        rec.publishing = iso(now);
        io.save(); // a lost publish response must never trigger a blind second publish
        const media = await net.ig.publish(id, rec.container);
        if (!media.id) throw new Error('instagram: publish returned no id; reconciliation required');
        rec.media_id = media.id;
        rec.published = iso(now);
        delete rec.publishing;
        last = now;
        io.save(); // keep media id even if permalink lookup fails
      }
      if (rec.published && !rec.submitted && now - Date.parse(rec.published) >= 0 && now - Date.parse(rec.published) <= WINDOW) {
        if (io.dry) { io.log(`would submit ${key}: ${rec.url || `media ${rec.media_id}`}`); continue; }
        if (!rec.url) {
          const media = await net.ig.permalink(rec.media_id);
          if (!/^https:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/[\w-]+\/?$/.test(media.permalink || '')) throw new Error('instagram: missing or invalid permalink');
          rec.url = media.permalink;
          io.save(); // URL is durable BEFORE the submit
          io.log(`published ${key}: ${rec.url} (slot ${q.at})`);
        }
        let res;
        try { res = await net.submit(key, q.campaign, rec.url); }
        catch (e) { res = { stage: 'error', error: e.message }; if (e.fatal) io.fatal.push(redactIG(e.message)); }
        io.log(`${key} -> ${q.campaign}: ${res.stage}${res.note ? ` (${res.note})` : ''}${res.error ? ` ${redactIG(res.error)}` : ''}`);
        if (res.stage === 'submitted') { rec.submitted = iso(now); delete rec.error; if (res.note) rec.note = res.note; }
        else { rec.error = redactIG(`${res.stage}: ${res.error || ''}`.trim()); if (['unauthorized', 'blocked'].includes(res.stage)) io.fatal.push(`${key}: ${rec.error}`); }
        delete io.caps?.[q.campaign]; // subsequent entries must see this run's new submission count
        io.save();
        if (!rec.asset_deleted) {
          try { await net.ig.deleteAsset(q.asset); rec.asset_deleted = true; io.save(); }
          catch (e) { io.log(`${key}: asset cleanup failed: ${redactIG(e.message)}`); }
        }
      }
    } catch (e) { rec.error = redactIG(e.message); if (!io.dry) io.save(); io.log(`${key}: ${rec.error}`); io.fatal.push(`${key}: ${rec.error}`); }
  }
}

const load = f => JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));

// laptop-state.json: clips the laptop published/submitted itself when a cloud run failed (whop_watch.py fallback).
// Only the laptop writes it; merged here so this runner skips them. Saved state.json then carries them too.
export function mergeLaptop(state, laptop) {
  for (const [vid, rec] of Object.entries(laptop)) state[vid] = { ...rec, ...state[vid] };
  return state;
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const queue = load('queue.json'), state = mergeLaptop(load('state.json'), existsSync(path.join(DIR, 'laptop-state.json')) ? load('laptop-state.json') : {});
  // Public repo: Actions logs are public too, so mask every clip, campaign, channel and post id before anything prints.
  if (process.env.GITHUB_ACTIONS)
    for (const [vid, q] of [...Object.entries(queue), ...Object.entries(state)])
      for (const v of [vid, vid.replace(/^\w+:/, ''), q.campaign, q.channel, q.source_channel, q.url, q.permalink]) if (v && String(v).length > 5) console.log(`::add-mask::${v}`);
  // STATE_OUT: a laptop run (refresh-session.mjs --local) saves to laptop-state.json, so each file keeps one writer.
  const io = { dry, log: m => console.log(`${new Date().toISOString().slice(0, 19)}Z ${m}`), fatal: [],
    save: () => dry || writeFileSync(path.join(DIR, process.env.STATE_OUT || 'state.json'), JSON.stringify(state, null, 1) + '\n') };
  try {
    const rows = await readReceipts();
    if (!dry) { const n = reconcileReceipts(queue, state, rows); if (n) { io.save(); io.log(`reconciled ${n} existing submission receipts`); } }
    else io.log(`receipt reconciliation readable: ${rows.length} records`);
  } catch (e) {
    io.log(e.message);
    io.fatal.push('receipt reconciliation unavailable; holding new publications');
    io.whop = 'receipt reconciliation unavailable';
    if (!dry) { process.exitCode = 1; return; }
  }
  if (!dry) await discoverUnregistered(queue, state, Date.now(), io);
  if (dry) {
    io.log(`whop session: ${await whopCheck()}`);
    io.log(`whop rest api: ${await restCheck()}`);
    // Submit path for every campaign with a clip due in the next 26 h: campaign open + REST auth, i.e. everything a
    // real submit needs short of the POST itself.
    const soon = Object.entries(queue).filter(([vid, q]) => !state[vid]?.submitted && slot(q.at) > Date.now() - WINDOW && slot(q.at) < Date.now() + 26 * 3600e3);
    for (const c of new Set(soon.map(([, q]) => q.campaign)))
      io.log(`submit ready ${c} (${soon.filter(([, q]) => q.campaign === c).map(([v, q]) => `${v}@${q.at}`).join(', ')}): cap ${await cap(c).catch(e => e.message)}, rest ${await restCheck(c)}`);
    for (const ch of new Set(Object.values(queue).map(q => q.channel).filter(Boolean)))
      try { await ytToken(ch); io.log(`youtube ${ch}: ok`); } catch (e) { io.log(`youtube ${ch}: ${e.message}`); }
    net.publish = async (vid, ch) => { io.log(`would publish ${vid} on ${ch}`); return false; };
    net.submit = async (vid, campaign, url) => ({ stage: 'dry-run', error: `would submit ${url || vid}` });
    // PROBE (workflow input): comma-separated post URLs, checked from this runner as social queue entries would be.
    for (const url of (process.env.PROBE || '').split(',').map(s => s.trim()).filter(Boolean)) {
      const q = socialEntry(url);
      if (!q) { io.log(`probe ${url}: not a TikTok or Instagram post URL`); continue; }
      let pub; try { pub = await net.isPublic(q.key, q); } catch (e) { pub = `error ${e.message}`; }
      if (q.platform === 'tiktok' && pub !== true) { // say why: status and the start of the body (no secrets involved)
        const r = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(q.url)}`, { headers: { 'user-agent': UA } }).catch(e => ({ status: e.message, text: async () => '' }));
        io.log(`probe ${q.key}: tiktok oembed HTTP ${r.status} ${(await r.text()).replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      io.log(`probe ${q.key}: public=${pub}; ${pub === true ? (await net.submit(q.key, 'ad06c6d9-d46f-4b03-9bf8-58bf8a09cf5b', q.url)).error : 'would wait'}`);
    }
    // IG_PROBE (workflow input): an ig-media asset name. Creates and uploads a Reel container, polls its status,
    // and never publishes (an unpublished container expires in 24 h). Proves the upload path end to end.
    if (process.env.IG_PROBE) try {
      const me = await net.ig.me(), c = await net.ig.create(me.user_id, 'probe (never published)', await net.ig.link(process.env.IG_PROBE));
      io.log(`ig probe: container ${c.id ? 'created' : 'missing'}`);
      let s; for (let i = 0; i < 18 && !['FINISHED', 'ERROR', 'EXPIRED'].includes(s); i++) { await new Promise(r => setTimeout(r, 10e3)); s = (await net.ig.status(c.id)).status_code; }
      io.log(`ig probe: status ${s} (not published)`);
    } catch (e) { io.log(`ig probe failed: ${redactIG(e.message)}`); }
  }
  // A laptop run (refresh-session.mjs --local) has no IG_TOKEN (it lives only in Actions secrets): leave IG to the cloud.
  if (!process.env.IG_TOKEN) io.log('no IG_TOKEN: instagram pass skipped');
  else try { await igPass(queue, state, Date.now(), io); }
  catch (e) { io.fatal.push(redactIG(e.message)); }
  await pass(queue, state, Date.now(), io);
  if (io.fatal.length) { console.error(`FAILED: ${io.fatal.join(' | ')}`); process.exitCode = 1; } // failed run -> GitHub emails
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
