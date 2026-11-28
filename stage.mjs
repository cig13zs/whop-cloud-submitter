#!/usr/bin/env node
// Laptop side of the cloud uploader (upload.mjs). Moves queued ytq clips to the cloud so they upload with
// the laptop off. Run it any time after a clip is approved; days ahead is fine.
//
//   node stage.mjs <slug> [slug...]   encrypt each mp4 into the draft release yt-media, add it to uploads.json,
//                                     take it off the laptop queue (ytq state needs_human "cloud: staged")
//   node stage.mjs sync               copy cloud results (video ids) back into the ytq job files
//   node stage.mjs list               show uploads.json
//
// Refuses to stage while the repo variable UPLOAD_ON is not "true" (the API audit is not through yet),
// because a staged clip leaves the laptop queue.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealBytes } from './crypt.mjs';
import { assetName, thumbAssetName } from './upload.mjs';
import { loadJobs, allItems, updateItem, ROOT as YTQ_ROOT } from '../../../tools/ytq/lib.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, 'uploads.json');
const REPO = 'cig13zs/whop-cloud-submitter';
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: DIR, stdio: 'pipe', timeout: 600_000, windowsHide: true }).toString().trim();
const node = args => sh(process.execPath, args);
const rows = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []);
export const normTitle = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const DEAD_STATES = new Set(['failed', 'missed', 'withdrawn', 'cancelled']);

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export const findDuplicateUpload = (list, { slug, channel, title, sha256 }) => {
  const nt = normTitle(title);
  for (const r of list) {
    if (DEAD_STATES.has(r.state)) continue;
    if (r.slug === slug) return { reason: 'slug', row: r };
    if (r.channel === channel && nt && normTitle(r.title) === nt) return { reason: 'channel+title', row: r };
    if (sha256 && r.sha256 && r.sha256 === sha256 && (r.channel === channel || r.campaign)) return { reason: 'sha256', row: r };
  }
  return null;
};

export const parseRssEntries = (xml) => {
  const entries = [];
  for (const m of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = m[1];
    const id = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] || '';
    const rawT = block.match(/<title>([^<]*)<\/title>/)?.[1] || '';
    const pub = block.match(/<published>([^<]+)<\/published>/)?.[1] || '';
    const title = rawT.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (id || title) entries.push({ id, title, published: pub });
  }
  return entries;
};

function fetchRssSafe(channelId) {
  try {
    const xml = execFileSync('curl.exe', ['-sL', '--max-time', '12', `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`], { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    return parseRssEntries(xml);
  } catch { return []; }
}

function ytqAlreadyUploaded(slug) {
  try {
    const p = path.join(YTQ_ROOT, 'run', `${slug}.out.json`);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    const m = raw.match(/youtube\.com\/shorts\/([\w-]{11})/);
    if (m || /"ok"\s*:\s*true/i.test(raw)) return m?.[1] || 'ytq-run-exists';
  } catch { /* ignore */ }
  return null;
}

// ytq keeps Manila wall-clock date + time ("Nov 15, 2026", "10:00 PM").
export const publishAtIso = (date, time) => {
  const ms = Date.parse(`${date} ${time} GMT+0800`);
  if (!Number.isFinite(ms)) throw new Error(`bad slot ${date} ${time}`);
  return new Date(ms).toISOString();
};

// Deterministic ±7..18 min human jitter keyed by slug so uploads never land on robotic :00:00 clock ticks.
export const jitterPublishAt = (isoStr, slug) => {
  let h = 2166136261;
  for (const ch of String(slug || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const mag = 7 + (h % 12); // 7..18 min
  const sign = (h & 1) ? 1 : -1;
  const base = Date.parse(isoStr);
  const shifted = base + sign * mag * 60_000;
  // Never pull a slot within 25 min of now into the past; push forward instead if close.
  const out = shifted < Date.now() + 25 * 60_000 ? base + mag * 60_000 : shifted;
  return new Date(out).toISOString();
};

// Map campaign UUID prefix / niche to YouTube categoryId (20 Gaming, 17 Sports, 27 Education, 24 Entertainment).
export const categoryForCampaign = (campaign) => {
  const p = String(campaign || '').slice(0, 8).toLowerCase();
  if (['802cf95a', '402a2657', '3b30ef83', '40562c73', 'f79c592a', '0d341d7d', '098c2c7a', '6b341aff', 'a5c63fad', 'dc7183a8', '1d2bcb00'].includes(p)) return '20';
  if (['91c5082d'].includes(p)) return '17';
  if (['463491d6'].includes(p)) return '27';
  return '24';
};

// Reject classic UTF-8 mojibake (double-encoded emojis/dashes) before staging to YouTube.
export const hasMojibake = (s) => /(?:\u00C3[\u0080-\u00BF]|\u00C2[\u0080-\u00BF]|\u00E2\u20AC|\uFFFD)/.test(String(s || ''));

// Enforce >=5h separation between active scheduled/published slots on the same channel (3/day 10:00/16:00/22:00 = 6h minus +/-18m jitter; Lorence 2026-11-28).
export const MIN_PUBLISH_GAP_MS = 5 * 3600e3;
export const findPublishGapConflict = (list, channel, publishAtIsoStr, minGapMs = MIN_PUBLISH_GAP_MS) => {
  const t = Date.parse(publishAtIsoStr);
  for (const r of list) {
    if (r.channel !== channel || ['failed', 'missed', 'withdrawn', 'cancelled'].includes(r.state) || !r.publishAt) continue;
    const dt = Math.abs(Date.parse(r.publishAt) - t);
    if (dt < minGapMs) return { slug: r.slug, publishAt: r.publishAt, gapH: +(dt / 3600e3).toFixed(2) };
  }
  return null;
};

function pullAndOpen() { sh('git', ['pull', '-q', '--rebase', '--autostash']); node(['crypt.mjs', 'open']); }
function sealAndPush(msg) {
  node(['crypt.mjs', 'seal', 'uploads.json']);
  sh('git', ['add', '--', 'uploads.json.enc']);
  try { sh('git', ['diff', '--cached', '--quiet']); return; } catch { /* staged changes: commit them */ }
  sh('git', ['commit', '-q', '-m', msg]);
  for (let i = 0; i < 3; i++) { try { sh('git', ['pull', '-q', '--rebase', '--autostash']); sh('git', ['push', '-q']); return; } catch (e) { if (i === 2) throw e; } }
}

function stage(slugs, force) {
  if (!force && sh('gh', ['variable', 'get', 'UPLOAD_ON', '-R', REPO]).toLowerCase() !== 'true') {
    throw new Error('UPLOAD_ON is not true (API audit not through?): staging would strand clips. Use --force only for a test.');
  }
  pullAndOpen();
  const list = rows();
  const items = allItems(loadJobs());
  try { sh('gh', ['release', 'view', 'yt-media', '-R', REPO]); }
  catch { sh('gh', ['release', 'create', 'yt-media', '--draft', '--title', 'yt-media', '--notes', 'Encrypted clip files for upload.mjs. Draft: never public.', '-R', REPO]); }
  const newChannels = new Set();
  const rssCache = new Map();
  for (const slug of slugs) {
    const it = items.find(x => x.slug === slug);
    if (!it) throw new Error(`${slug}: not in any ytq job file`);
    if (it.state !== 'queued') throw new Error(`${slug}: ytq state is ${it.state}, only queued clips can move to the cloud`);
    if (hasMojibake(it.title) || hasMojibake(it.description)) throw new Error(`${slug}: UTF-8 mojibake detected in title/description; fix encoding before staging`);

    const ytqVid = ytqAlreadyUploaded(slug);
    if (ytqVid && !force) throw new Error(`${slug}: already uploaded locally by ytq (${ytqVid}); refusing duplicate cloud upload`);

    const fileBytes = readFileSync(it.file);
    const sha256 = sha256Hex(fileBytes);
    const dup = findDuplicateUpload(list, { slug, channel: it.channel_id, title: it.title, sha256 });
    if (dup && !(force && dup.reason === 'slug')) {
      throw new Error(`${slug}: duplicate (${dup.reason}) of uploads.json row ${dup.row.slug} (${dup.row.state}, ${dup.row.channel}); refusing stage`);
    }

    if (!rssCache.has(it.channel_id)) rssCache.set(it.channel_id, fetchRssSafe(it.channel_id));
    const rssEntries = rssCache.get(it.channel_id);
    const nt = normTitle(it.title);
    const rssDup = rssEntries.find(e => nt && normTitle(e.title) === nt);
    if (rssDup && !force) {
      throw new Error(`${slug}: live YouTube RSS on ${it.channel_id} already has "${rssDup.title}" (${rssDup.id}); refusing duplicate upload`);
    }

    const pubAt = jitterPublishAt(publishAtIso(it.date, it.time), slug);
    const conflict = findPublishGapConflict(list, it.channel_id, pubAt);
    if (conflict && !force) throw new Error(`${slug}: publishAt ${pubAt} is only ${conflict.gapH}h from ${conflict.slug} (${conflict.publishAt}) on ${it.channel_id} (<5h min separation)`);
    if (!list.some(r => r.channel === it.channel_id)) newChannels.add(it.channel_id);

    // Lock ytq item BEFORE uploading to gh release so the laptop YT Queue Worker cannot race and double-upload during the ~2m transfer.
    updateItem(it.jobFile, slug, x => { x.state = 'needs_human'; x.last_error = 'cloud: locking for upload.mjs'; return 'locked before cloud media upload'; });

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'stage-'));
    let thumbMime = null;
    try {
      const enc = path.join(tmp, assetName(slug));
      writeFileSync(enc, sealBytes(fileBytes));
      sh('gh', ['release', 'upload', 'yt-media', enc, '--clobber', '-R', REPO]);
      if (it.thumbnail && existsSync(it.thumbnail)) {
        const ext = path.extname(it.thumbnail).toLowerCase();
        thumbMime = (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';
        const tEnc = path.join(tmp, thumbAssetName(slug));
        writeFileSync(tEnc, sealBytes(readFileSync(it.thumbnail)));
        sh('gh', ['release', 'upload', 'yt-media', tEnc, '--clobber', '-R', REPO]);
      }
    } catch (err) {
      updateItem(it.jobFile, slug, x => { x.state = 'queued'; x.last_error = `cloud stage aborted: ${String(err?.message || err).slice(0, 120)}`; return 'unlocked after stage error'; });
      throw err;
    } finally { rmSync(tmp, { recursive: true, force: true }); }

    list.push({ slug, channel: it.channel_id, title: it.title, description: it.description || '',
      categoryId: it.categoryId || categoryForCampaign(it.campaign), defaultLanguage: 'en', defaultAudioLanguage: 'en',
      publishAt: pubAt, sha256,
      ...(thumbMime ? { thumbnail: thumbMime } : {}),
      campaign: it.campaign || null, state: 'staged', staged_at: new Date().toISOString() });
    writeFileSync(FILE, JSON.stringify(list, null, 1) + '\n');
    updateItem(it.jobFile, slug, x => { x.state = 'needs_human'; x.last_error = 'cloud: staged (cloud-submitter uploads.json)'; return 'staged to cloud uploader'; });
    console.log(`${slug}: staged for ${it.channel_name || it.channel_id} at ${it.date} ${it.time} Manila`);
  }
  sealAndPush(`uploads: stage ${slugs.length}`);
  // The cloud needs a refresh token for each channel it uploads to.
  if (newChannels.size) { console.log(`new channel(s) ${[...newChannels].join(', ')}: refreshing YT_REFRESH_TOKENS`); console.log(node(['refresh-session.mjs', '--yt'])); }
}

function sync() {
  pullAndOpen();
  const items = allItems(loadJobs());
  for (const r of rows().filter(r => r.video_id)) {
    const it = items.find(x => x.slug === r.slug);
    if (!it || it.video_id === r.video_id) continue;
    updateItem(it.jobFile, r.slug, x => {
      Object.assign(x, { state: 'verified', video_id: r.video_id, url: `https://youtube.com/shorts/${r.video_id}`, last_error: null });
      return `cloud upload ${r.state}`;
    });
    console.log(`${r.slug}: ${r.video_id} (${r.state})`);
  }
  for (const r of rows().filter(r => ['failed', 'missed', 'locked'].includes(r.state))) console.log(`NEEDS A LOOK ${r.slug}: ${r.state} ${r.error || ''}`);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'sync') sync();
  else if (cmd === 'list') { pullAndOpen(); for (const r of rows()) console.log(`${r.state.padEnd(8)} ${r.publishAt} ${r.slug} ${r.video_id || ''}`); }
  else if (cmd === 'selftest') {
    if (publishAtIso('Nov 15, 2026', '10:00 PM') !== '2026-11-15T14:00:00.000Z') throw new Error('Manila slot -> UTC');
    if (publishAtIso('Nov 16, 2026', '4:00 AM') !== '2026-11-15T20:00:00.000Z') throw new Error('early slot crosses the day back');
    const j = Date.parse(jitterPublishAt('2099-11-15T14:00:00.000Z', 'test-slug-01')) - Date.parse('2099-11-15T14:00:00.000Z');
    if (Math.abs(j) < 7 * 60_000 || Math.abs(j) > 18 * 60_000) throw new Error(`jitter out of bounds: ${j}`);
    if (categoryForCampaign('802cf95a-0000') !== '20' || categoryForCampaign('91c5082d-0000') !== '17' || categoryForCampaign('463491d6-0000') !== '27' || categoryForCampaign('c3e0abdc-0000') !== '24') throw new Error('category map');
    if (!hasMojibake('Wild clip \u00C3\u00B0\u00C5\u00B8') || hasMojibake('Wild clip \uD83D\uDE2D')) throw new Error('mojibake guard');
    if (!findPublishGapConflict([{ slug: 'x1', channel: 'UC1', state: 'staged', publishAt: '2099-11-15T14:00:00.000Z' }], 'UC1', '2099-11-15T18:00:00.000Z')) throw new Error('5h gap guard failed to catch 4h conflict');
    if (findPublishGapConflict([{ slug: 'x1', channel: 'UC1', state: 'staged', publishAt: '2099-11-15T14:00:00.000Z' }], 'UC1', '2099-11-15T19:30:00.000Z')) throw new Error('5h gap guard rejected 5.5h gap');
    const sampleRows = [{ slug: 's1', channel: 'UC1', state: 'uploaded', title: 'Secret   Portal  Fix', sha256: 'abc', campaign: '802cf95a' }];
    if (findDuplicateUpload(sampleRows, { slug: 's2', channel: 'UC1', title: 'secret portal fix', sha256: 'def' })?.reason !== 'channel+title') throw new Error('dup title guard');
    if (findDuplicateUpload(sampleRows, { slug: 's2', channel: 'UC2', title: 'Other', sha256: 'abc' })?.reason !== 'sha256') throw new Error('dup sha256 guard');
    if (parseRssEntries('<feed><entry><yt:videoId>vid12345678</yt:videoId><title>Boss &amp; Portal</title><published>2026-11-26T00:00:00Z</published></entry></feed>')[0]?.title !== 'Boss & Portal') throw new Error('rss parse');
    console.log('stage selftest ok');
  }
  else if (cmd && !cmd.startsWith('-')) stage([cmd, ...rest].filter(s => !s.startsWith('-')), rest.includes('--force'));
  else throw new Error('usage: node stage.mjs <slug...> [--force] | sync | list | selftest');
} catch (e) { console.error(e.message); process.exitCode = 1; }
