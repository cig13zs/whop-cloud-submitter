#!/usr/bin/env node
// Cloud uploader: uploads staged clips to YouTube as scheduled Shorts (private + publishAt), so the laptop
// can be off. The laptop only stages (stage.mjs): it encrypts the mp4 into the draft release `yt-media` and
// adds a row to uploads.json. YouTube flips the video public at publishAt; run.mjs then submits it to CR as
// for any public upload on a mapped channel.
//
// Google keeps every video uploaded by an unaudited API project private ("locked"), so this stays off
// (repo variable UPLOAD_ON) until the YouTube API audit passes. A clip still private 15 min after its
// publishAt is marked `locked` and fails the run loudly.
//
//   node upload.mjs [--dry-run]   one pass (needs YT_CLIENT, YT_REFRESH_TOKENS, DATA_KEY, GH_TOKEN)
//   node upload.mjs selftest      offline test with a fake YouTube
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { publicEncrypt } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBytes, sealBytes } from './crypt.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, 'uploads.json');
const RELEASE = 'yt-media';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const THUMB = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?uploadType=media&videoId=';
const YT = 'https://www.googleapis.com/youtube/v3/';
// Budget: videos.insert has its own default bucket of 100 calls a day, apart from the 10,000 units the reads
// use (Google's quota guide, updated 2026-11-12). 40/day supports 10+/day across multiple Google accounts.
const PER_DAY = Number(process.env.UPLOADS_PER_DAY || 40);
const MAX_PER_RUN = Number(process.env.MAX_UPLOADS_PER_RUN || 3);
const MAX_LEAD_MS = Number(process.env.MAX_UPLOAD_LEAD_H || 24) * 3600e3; // keep >24h rows staged in yt-media until <24h before publishAt
const MIN_CHANNEL_UPLOAD_GAP_MS = Number(process.env.MIN_CHANNEL_UPLOAD_GAP_H || 4) * 3600e3;
const MIN_LEAD_MS = 20 * 60e3; // YouTube rejects a publishAt in the past; don't race one that is minutes away
const LOCK_AFTER_MS = 15 * 60e3;
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

export const assetName = slug => `${slug}.mp4.enc`;
export const thumbAssetName = slug => `${slug}.thumb.enc`;
const pacificDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

// One pass over uploads.json rows: { slug, channel, title, description, publishAt, categoryId?, state, ... }
// states: staged -> uploaded (video_id) -> live, or failed / locked / missed.
export async function pass(rows, { now = Date.now(), io, dry = false, sleep = sleepMs, maxPerRun = MAX_PER_RUN, maxLeadMs = MAX_LEAD_MS, minChGapMs = MIN_CHANNEL_UPLOAD_GAP_MS } = {}) {
  const log = [], fatal = [];
  const today = pacificDay(now);
  let used = rows.filter(r => r.uploaded_at && pacificDay(Date.parse(r.uploaded_at)) === today).length;
  let runUploaded = 0;
  const chUploadedThisRun = new Set();

  // 1) Readback: did YouTube make the uploaded ones public? Still private after publishAt = the audit lock.
  for (const r of rows.filter(r => r.state === 'uploaded' && Date.parse(r.publishAt) + LOCK_AFTER_MS < now)) {
    const s = await io.status(r.channel, r.video_id);
    if (s?.privacyStatus === 'public') { r.state = 'live'; log.push(`${r.slug} ${r.video_id} is public`); }
    else { r.state = 'locked'; fatal.push(`${r.slug} ${r.video_id} still ${s?.privacyStatus || 'missing'} 15 min after publishAt: API audit lock? Set it public in Studio and turn UPLOAD_ON off`); }
  }

  // 2) Upload staged rows, earliest slot first — anti-burst paced (<24h lead, max 1/channel/run, max 3/run, >=4h channel gap).
  for (const r of rows.filter(r => r.state === 'staged').sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt))) {
    const at = Date.parse(r.publishAt);
    if (!(at > now + MIN_LEAD_MS)) { r.state = 'missed'; fatal.push(`${r.slug}: publishAt ${r.publishAt} passed before upload; restage it on a later slot`); continue; }
    if (at - now > maxLeadMs) { log.push(`${r.slug}: waiting (${Math.round((at - now) / 3600e3)}h ahead > ${Math.round(maxLeadMs / 3600e3)}h lead window)`); continue; }
    if (used >= PER_DAY) { log.push(`${r.slug}: daily upload budget ${PER_DAY} used; next Pacific day`); continue; }
    if (runUploaded >= maxPerRun) { log.push(`${r.slug}: per-run anti-burst cap (${maxPerRun}) reached; next 30m tick`); continue; }
    if (chUploadedThisRun.has(r.channel)) { log.push(`${r.slug}: 1/channel/run cap on ${r.channel}; next tick`); continue; }
    const lastChUp = rows.filter(x => x.channel === r.channel && x.uploaded_at).reduce((m, x) => Math.max(m, Date.parse(x.uploaded_at) || 0), 0);
    if (lastChUp && now - lastChUp < minChGapMs) { log.push(`${r.slug}: channel ${r.channel} uploaded ${Math.round((now - lastChUp) / 60e3)}m ago (<${Math.round(minChGapMs / 3600e3)}h gap); waiting`); continue; }
    if (dry) { log.push(`DRY ${r.slug} -> ${r.channel} at ${r.publishAt}`); runUploaded++; chUploadedThisRun.add(r.channel); continue; }
    try {
      if (runUploaded > 0 && sleep) await sleep(20_000 + Math.floor(Math.random() * 25_000));
      const bytes = openBytes(io.download(assetName(r.slug)));
      const video = await io.insert(r.channel, {
        snippet: {
          title: r.title,
          description: r.description || '',
          categoryId: r.categoryId || '24',
          defaultLanguage: r.defaultLanguage || 'en',
          defaultAudioLanguage: r.defaultAudioLanguage || 'en',
        },
        status: { privacyStatus: 'private', publishAt: new Date(at).toISOString(), selfDeclaredMadeForKids: false, containsSyntheticMedia: false },
      }, bytes);
      if (!video?.id) throw new Error('no video id in the upload response');
      if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${video.id}`); // public log, like run.mjs
      if (Date.parse(video.status?.publishAt) !== at) throw new Error(`publishAt read back ${video.status?.publishAt}, wanted ${r.publishAt}`);
      Object.assign(r, { state: 'uploaded', video_id: video.id, uploaded_at: new Date(now).toISOString(), error: null });
      used++;
      runUploaded++;
      chUploadedThisRun.add(r.channel);
      log.push(`${r.slug} uploaded ${video.id} on ${r.channel}, public at ${r.publishAt}`);
      if (r.thumbnail && io.setThumbnail) {
        try {
          const tBytes = openBytes(io.download(thumbAssetName(r.slug)));
          await io.setThumbnail(r.channel, video.id, tBytes, r.thumbnail);
          r.thumbnail_applied = true;
          log.push(`${r.slug}: custom thumbnail applied`);
          try { io.deleteAsset(thumbAssetName(r.slug)); } catch { /* harmless */ }
        } catch (e) {
          r.thumbnail_error = e.message;
          log.push(`${r.slug}: custom thumbnail skipped (${e.message})`);
        }
      }
      try { io.deleteAsset(assetName(r.slug)); } catch (e) { log.push(`${r.slug}: asset delete failed (${e.message}); harmless`); }
    } catch (e) {
      r.attempts = (r.attempts || 0) + 1;
      r.error = e.message;
      if (/quotaExceeded|dailyLimitExceeded|uploadLimitExceeded/i.test(e.message)) { log.push(`${r.slug}: ${e.message}; stopping this pass`); break; }
      if (r.attempts >= 3) { r.state = 'failed'; fatal.push(`${r.slug} failed 3 times: ${e.message}`); }
      else log.push(`${r.slug} attempt ${r.attempts} failed: ${e.message}`);
    }
  }

  // 3) Register VIDEOID=CAMPAIGN (register/*.txt) so the runner watches the private video and submits it the run it
  // goes public. 11-23: without this a cloud upload on a channel with no map rule went public and was never submitted.
  for (const r of rows.filter(r => r.video_id && r.campaign && !r.registered)) {
    if (dry) { log.push(`DRY register ${r.slug}`); continue; }
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.campaign)) { fatal.push(`${r.slug}: campaign "${r.campaign}" is not a full CR campaign UUID; register it by hand`); continue; }
    try { io.register(r.video_id, r.campaign); r.registered = new Date(now).toISOString(); log.push(`${r.slug} registered for submit at go-live`); }
    catch (e) { fatal.push(`${r.slug}: registration failed (${e.message}); it will NOT be submitted unless registered`); }
  }
  return { log, fatal };
}

// --- real I/O (GitHub Actions) ---
async function ytFetch(channel, url, init) {
  const { ytToken } = await import('./run.mjs');
  const r = await fetch(url, { ...init, headers: { ...init?.headers, authorization: `Bearer ${await ytToken(channel)}` } });
  return r;
}
async function apiError(r) {
  const d = await r.json().catch(() => ({}));
  return new Error(`${r.status} ${d.error?.errors?.[0]?.reason || ''} ${d.error?.message || ''}`.trim());
}
const gh = args => execFileSync('gh', ['release', ...args, '-R', 'cig13zs/whop-cloud-submitter'], { stdio: 'pipe', timeout: 300_000 });
export const realIO = {
  download(asset) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ytm-'));
    try { gh(['download', RELEASE, '--pattern', asset, '--dir', tmp]); return readFileSync(path.join(tmp, asset)); }
    finally { rmSync(tmp, { recursive: true, force: true }); }
  },
  deleteAsset: asset => gh(['delete-asset', RELEASE, asset, '-y']),
  // One new register/ file per pass (README: add files, never edit old ones); upload.yml commits it.
  register(vid, campaign) {
    const line = publicEncrypt({ key: readFileSync(path.join(DIR, 'register.pub')), oaepHash: 'sha256' }, Buffer.from(`${vid}=${campaign}`)).toString('base64');
    this.regFile ||= path.join(DIR, 'register', `cloud-upload-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    appendFileSync(this.regFile, line + '\n');
  },
  async insert(channel, body, bytes) {
    const init = await ytFetch(channel, UPLOAD, { method: 'POST', body: JSON.stringify(body), headers: {
      'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(bytes.length) } });
    if (!init.ok) throw await apiError(init);
    const put = await ytFetch(channel, init.headers.get('location'), { method: 'PUT', body: bytes, headers: { 'content-type': 'video/mp4' } });
    if (!put.ok) throw await apiError(put);
    return put.json();
  },
  async setThumbnail(channel, videoId, bytes, mime = 'image/png') {
    const r = await ytFetch(channel, `${THUMB}${encodeURIComponent(videoId)}`, {
      method: 'POST', body: bytes, headers: { 'content-type': mime },
    });
    if (!r.ok) throw await apiError(r);
    return r.json();
  },
  async status(channel, id) {
    const r = await ytFetch(channel, `${YT}videos?part=status&id=${encodeURIComponent(id)}`);
    if (!r.ok) throw await apiError(r);
    return (await r.json()).items?.[0]?.status;
  },
};

async function main(argv) {
  if (argv[0] === 'selftest') return selftest();
  if (!existsSync(FILE)) return console.log('no uploads.json; nothing staged');
  const rows = JSON.parse(readFileSync(FILE, 'utf8'));
  const { log, fatal } = await pass(rows, { io: realIO, dry: argv.includes('--dry-run') });
  for (const l of log) console.log(l);
  if (!argv.includes('--dry-run')) writeFileSync(FILE, JSON.stringify(rows, null, 1) + '\n');
  for (const f of fatal) console.log(`FATAL ${f}`);
  if (fatal.length) process.exitCode = 2;
}

async function selftest() {
  const assert = (c, m) => { if (!c) throw new Error(`selftest: ${m}`); };
  const { randomBytes } = await import('node:crypto');
  process.env.DATA_KEY = randomBytes(32).toString('base64');
  const now = Date.parse('2026-11-14T10:00:00Z');
  const mp4 = Buffer.from('fake mp4 bytes');
  const assets = { [assetName('a')]: sealBytes(mp4), [assetName('b')]: sealBytes(mp4), [assetName('c')]: sealBytes(mp4) };
  const sent = [], deleted = [];
  const io = {
    download: n => { if (!assets[n]) throw new Error('no asset'); return assets[n]; },
    deleteAsset: n => deleted.push(n),
    insert: async (ch, body, bytes) => { sent.push({ ch, body, bytes }); return { id: `vid${sent.length}`, status: { publishAt: body.status.publishAt } }; },
    status: async (ch, id) => ({ privacyStatus: id === 'old1' ? 'public' : 'private' }),
    register: (vid, campaign) => regs.push(`${vid}=${campaign}`),
  };
  const regs = [];
  const CAMP = 'de2b2ee3-bb22-453e-ae1a-c07bf89c5ef4';
  const iso = h => new Date(now + h * 3600e3).toISOString();
  const rows = [
    { slug: 'b', channel: 'UC2', title: 'B', publishAt: iso(12), state: 'staged' },
    { slug: 'a', channel: 'UC1', title: 'A', publishAt: iso(6), state: 'staged', campaign: CAMP },
    { slug: 'a2', channel: 'UC1', title: 'A2 same ch', publishAt: iso(18), state: 'staged' },
    { slug: 'far', channel: 'UC3', title: 'Far 48h', publishAt: iso(48), state: 'staged' },
    { slug: 'pre', channel: 'UC1', state: 'uploaded', video_id: 'pre1', publishAt: iso(3), campaign: 'de2b2ee3' },
    { slug: 'late', channel: 'UC1', title: 'L', publishAt: iso(0.1), state: 'staged' },
    { slug: 'old', channel: 'UC1', state: 'uploaded', video_id: 'old1', publishAt: iso(-1) },
    { slug: 'stuck', channel: 'UC1', state: 'uploaded', video_id: 'stuck1', publishAt: iso(-1) },
    { slug: 'soon', channel: 'UC1', state: 'uploaded', video_id: 'soon1', publishAt: iso(-0.1) },
  ];
  const { fatal } = await pass(rows, { now, io, sleep: null });
  const by = s => rows.find(r => r.slug === s);
  assert(sent.length === 2 && sent[0].body.snippet.title === 'A' && sent[1].body.snippet.title === 'B', 'uploads earliest slot first across channels');
  assert(by('a2').state === 'staged', 'enforces max 1 upload per channel per run');
  assert(by('far').state === 'staged', 'holds >24h lead rows staged until inside lead window');
  assert(sent[0].bytes.equals(mp4), 'decrypts the asset before upload');
  assert(sent[0].body.status.privacyStatus === 'private' && sent[0].body.status.publishAt === iso(6), 'scheduled private with publishAt');
  assert(sent[0].body.status.containsSyntheticMedia === false && sent[0].body.status.selfDeclaredMadeForKids === false, 'altered + kids off');
  assert(sent[0].body.snippet.defaultLanguage === 'en' && sent[0].body.snippet.defaultAudioLanguage === 'en', 'defaults to English language/audio tags');
  assert(by('a').state === 'uploaded' && by('a').video_id === 'vid1', 'records the video id');
  assert(deleted.includes(assetName('a')), 'deletes the uploaded asset');
  assert(by('late').state === 'missed', 'a slot under 20 min away is missed, not raced');
  assert(by('old').state === 'live', 'public after publishAt -> live');
  assert(by('stuck').state === 'locked' && fatal.some(f => /audit lock/.test(f)), 'still private after publishAt -> locked + fatal');
  assert(by('soon').state === 'uploaded', 'inside the 15 min grace it is left alone');
  assert(regs.length === 1 && regs[0] === `vid1=${CAMP}` && by('a').registered, 'an upload with a campaign registers VIDEOID=CAMPAIGN');
  assert(!by('pre').registered && fatal.some(f => /pre: campaign "de2b2ee3" is not a full/.test(f)), 'a campaign prefix is refused loudly, never registered');
  await pass(rows, { now, io, sleep: null });
  assert(regs.length === 1, 'a registered row is not registered again');
  assert(by('a2').state === 'staged', 'enforces 4h channel upload gap on immediate retry');

  // per-run anti-burst cap & daily budget, quota stop, retries
  const burst = Array.from({ length: 5 }, (_, i) => ({ slug: 'c', channel: `UCB${i}`, title: `B${i}`, publishAt: iso(5 + i), state: 'staged' }));
  sent.length = 0;
  await pass(burst, { now, io, sleep: null });
  assert(sent.length === 3, 'stops at 3 uploads per run by default');
  const many = Array.from({ length: PER_DAY + 2 }, (_, i) => ({ slug: 'c', channel: `UCD${i}`, title: `C${i}`, publishAt: iso(5 + (i % 12)), state: 'staged' }));
  sent.length = 0;
  await pass(many, { now, io, sleep: null, maxPerRun: PER_DAY + 5 });
  assert(sent.length === PER_DAY, `stops at ${PER_DAY} uploads per Pacific day`);
  const q = [{ slug: 'a', channel: 'UC1', title: 'Q1', publishAt: iso(5), state: 'staged' }, { slug: 'b', channel: 'UC2', title: 'Q2', publishAt: iso(6), state: 'staged' }];
  let calls = 0;
  await pass(q, { now, io: { ...io, insert: async () => { calls++; throw new Error('403 quotaExceeded'); } }, sleep: null });
  assert(calls === 1 && q[0].state === 'staged', 'quotaExceeded stops the pass and keeps the row staged');
  const f = [{ slug: 'a', channel: 'UC1', title: 'F', publishAt: iso(5), state: 'staged', attempts: 2 }];
  const r3 = await pass(f, { now, io: { ...io, insert: async () => { throw new Error('500 backendError'); } }, sleep: null });
  assert(f[0].state === 'failed' && r3.fatal.length === 1, 'third failure -> failed + fatal');
  const bad = [{ slug: 'a', channel: 'UC1', title: 'P', publishAt: iso(5), state: 'staged' }];
  await pass(bad, { now, io: { ...io, insert: async () => ({ id: 'x', status: { privacyStatus: 'private' } }) }, sleep: null });
  assert(bad[0].state === 'staged' && /publishAt read back/.test(bad[0].error), 'a lost publishAt is an error, not success');
  const dry = [{ slug: 'a', channel: 'UC1', title: 'D', publishAt: iso(5), state: 'staged' }];
  sent.length = 0;
  await pass(dry, { now, io, dry: true, sleep: null });
  assert(sent.length === 0 && dry[0].state === 'staged', 'dry run uploads nothing');
  // custom thumbnail upload + non-fatal fallback
  const thumbBytes = Buffer.from('fake png bytes');
  assets[thumbAssetName('a')] = sealBytes(thumbBytes);
  const thumbs = [];
  const tRow = [{ slug: 'a', channel: 'UC1', title: 'T', publishAt: iso(5), state: 'staged', thumbnail: 'image/png' }];
  await pass(tRow, { now, io: { ...io, setThumbnail: async (ch, id, b, m) => thumbs.push({ ch, id, b, m }) }, sleep: null });
  assert(tRow[0].state === 'uploaded' && tRow[0].thumbnail_applied === true && thumbs.length === 1 && thumbs[0].b.equals(thumbBytes) && deleted.includes(thumbAssetName('a')), 'applies custom thumbnail and deletes thumb asset');
  assets[thumbAssetName('b')] = sealBytes(thumbBytes);
  const tFail = [{ slug: 'b', channel: 'UC2', title: 'T2', publishAt: iso(5), state: 'staged', thumbnail: 'image/png' }];
  await pass(tFail, { now, io: { ...io, setThumbnail: async () => { throw new Error('403 forbidden phone verify'); } }, sleep: null });
  assert(tFail[0].state === 'uploaded' && /403 forbidden/.test(tFail[0].thumbnail_error), 'thumbnail 403 is non-fatal so video still schedules');
  console.log('upload selftest ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
