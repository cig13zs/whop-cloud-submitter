// Offline selftest for run.mjs: every HTTP call goes to a fake fetch, so the real request/parse code runs.
// Cases: due, not-due, gap, 30-minute-expired, API-refused (YouTube and Content Rewards), duplicate, feed, cap, auth.
import assert from 'node:assert/strict';
import { mergeCookies, pass, slot, GAP, mergeLaptop, socialEntry, igPass, net, IG_VERSION, reconcileReceipts } from './run.mjs';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CAMP = 'camp-1', SARTAIN = '86842687-ba2b-4638-a024-995dcf3d25a3';
const now = slot('2026-10-01 12:00');
const calls = [];
let session = 'ok', checks = 0, feedXml = '', publicVids = new Set(), crResult = {}, ytPutFail = new Set(), campaignStatus = {};
const publishedDates = new Map();
process.env.WHOP_CR_COOKIE = '__Host-cr-session=fake; __Host-cr-whop-id=fake';
process.env.YT_CLIENT = JSON.stringify({ client_id: 'id', client_secret: 'sec' });
process.env.YT_REFRESH_TOKENS = JSON.stringify({ UCx: 'rt-x', UCx2: 'rt-x', UCy: 'rt-y' });

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
globalThis.fetch = async (url, opt = {}) => {
  url = String(url);
  const method = opt.method || 'GET';
  if (url.includes('/feeds/videos.xml')) return new Response(feedXml);
  if (url.includes('tiktok.com/oembed')) return new Response('{}', { status: publicVids.has('tt:' + decodeURIComponent(url).split('/video/')[1]) ? 200 : 400 });
  if (url.includes('/oembed')) return new Response('{}', { status: publicVids.has(url.split('/shorts/')[1]) ? 200 : 401 });
  if (url.includes('/api/campaign/campaigns/')) {
    const id = url.split('/').pop();
    if (campaignStatus[id]?.broken) return json({ success: false });
    return json({ data: { status: campaignStatus[id]?.status || 'active', configuration: campaignStatus[id]?.cap ? { maxSubmissionsPerUser: campaignStatus[id].cap } : {} } });
  }
  if (url.includes('oauth2.googleapis.com/token')) {
    const rt = new URLSearchParams(opt.body).get('refresh_token');
    return rt === 'rt-x' ? json({ access_token: 'at-x', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
  }
  if (url.includes('youtube/v3/videos') && method === 'GET') { const id = new URL(url).searchParams.get('id'); return json({ items: [{ status: { privacyStatus: publicVids.has(id) ? 'public' : 'private', madeForKids: false }, snippet: { publishedAt: new Date(publishedDates.get(id) ?? now - 60000).toISOString() } }] }); }
  if (url.includes('youtube/v3/videos') && method === 'PUT') {
    const body = JSON.parse(opt.body);
    calls.push(`publish ${body.id}`);
    assert.equal(body.status.publishAt, null); // the Studio schedule must be dropped explicitly
    assert.equal(body.status.madeForKids, false); // existing status fields are kept
    return ytPutFail.has(body.id) ? json({ error: { errors: [{ reason: 'forbidden' }] } }, 403) : json({ id: body.id, status: { privacyStatus: 'public' } });
  }
  if (url.includes('apps.whop.com/c/_next/static/chunks/a.js')) return new Response('x;"static/chunks/b.js";');
  if (url.includes('apps.whop.com/c/_next/static/chunks/b.js')) return new Response(
    'l=(0,n.createServerReference)("40ad8b5c2c00000000000000000000000000000000",n.callServer,void 0,n.findSourceMapURL,"listMySubmissionsAction");' +
    'r=(0,t.createServerReference)("00a318a0184953d9eea4b343164f65435b33950cc4",t.callServer,void 0,t.findSourceMapURL,"refreshSession");');
  if (url.includes('apps.whop.com/c/exp_') && method === 'GET') return new Response('<script src="/c/_next/static/chunks/a.js"></script>');
  if (url.includes('apps.whop.com/c/exp_') && method === 'POST' && opt.headers['next-action'].startsWith('00a318a0')) {
    calls.push('refresh');
    return new Response('0:{}\n1:{"success":true}\n', { headers: [['set-cookie', '__Host-cr-session=fresh; Path=/; HttpOnly'], ['set-cookie', '__Host-cr-access=a2; Path=/']] });
  }
  if (url.endsWith('apps.whop.com/api/submission/appeals/standing') && method === 'GET') { // whopCheck -> restCheck
    if (calls.at(-1) !== 'refresh') checks++; // the retry right after a refresh is the same check
    if (session === 'cf') return new Response('<html>challenge</html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    return session === 'ok' ? json({ error: { code: 'VALIDATION' }, success: false }, 422) : json({ error: { code: 'NOT_AUTHORIZED' }, success: false }, 401);
  }
  if (url.endsWith('apps.whop.com/api/submission/submissions') && method === 'POST') {
    assert.match(opt.headers.cookie, /__Host-cr-session=/);
    const { campaignId, url: post } = JSON.parse(opt.body);
    assert.ok(campaignId);
    const vid = socialEntry(post)?.key || post.split('v=')[1];
    if (vid.startsWith('tt:') || vid.startsWith('ig:')) calls.push(`url ${post}`);
    calls.push(`submit ${vid}`);
    const r = crResult[vid]?.stale && !calls.includes('refresh') // stale until this run refreshes (the cookie stays fresh across tests)
      ? { code: 'NOT_AUTHORIZED', error: 'Authentication required', success: false }
      : crResult[vid]?.stale ? { success: true } : crResult[vid]?.times === 0 ? { data: { id: 'sub_1' }, success: true } : crResult[vid] || { data: { id: 'sub_1' }, success: true };
    if (crResult[vid]?.times) crResult[vid].times--;
    if (r.cf) return new Response('<html>challenge</html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    if (r.success) return json(r, 201);
    return json({ error: { code: r.code, message: r.error }, success: false }, r.code === 'NOT_AUTHORIZED' ? 401 : r.code === 'CONFLICT' ? 409 : 400);
  }
  throw new Error(`unmocked ${method} ${url}`);
};

async function run(queue, state, t = now) {
  calls.length = 0; checks = 0;
  const io = { log: m => console.log('   ', m), fatal: [], save() {}, wait: async () => calls.push('wait') };
  await pass(queue, state, t, io);
  return { calls: [...calls], fatal: io.fatal, checks };
}
let cases = 0;
const test = async (name, fn) => { console.log(`- ${name}`); await fn(); cases++; console.log('  ok'); };

await test('monitor entries can never publish or submit; an early public clip raises an alert', async () => {
  const queue = { watch: { campaign: CAMP, at: '2026-10-01 13:00', source_channel: 'UCx', mode: 'monitor' } }, state = {};
  assert.deepEqual((await run(queue, state)).calls, []);
  publicVids = new Set(['watch']);
  const r = await run(queue, state);
  assert.deepEqual(r.calls, []); assert.equal(r.fatal.length, 1); assert.ok(state.watch.coverage_alert);
  assert.equal((await run(queue, state)).fatal.length, 0);
  publicVids = new Set();
});

await test('actual receipts bind campaign and author, clear duplicate errors, and keep rejection distinct', async () => {
  const q = { got: { campaign: CAMP, source_channel: 'UCx', mode: 'monitor' } }, s = { got: { error: 'duplicate failure' } };
  const receipt = { id: 'r-real', campaignId: CAMP, createdAt: '2026-10-01T03:58:00Z', status: 'rejected', reviewStatus: 'reviewed', socialMediaPost: { postId: 'got', authorId: 'UCx', postUrl: 'https://youtube.com/watch?v=got' } };
  assert.equal(reconcileReceipts(q, s, [{ ...receipt, campaignId: 'other' }]), 0);
  assert.equal(reconcileReceipts(q, s, [{ ...receipt, socialMediaPost: { ...receipt.socialMediaPost, authorId: 'other' } }]), 0);
  assert.equal(reconcileReceipts(q, s, [receipt]), 1);
  assert.equal(s.got.whop_receipt.receipt_id, 'r-real'); assert.equal(s.got.whop_receipt.status, 'rejected'); assert.ok(!s.got.error);
  assert.equal(reconcileReceipts(q, s, [receipt]), 0);
});

await test('due: a held clip past its slot is published, then submitted in the same pass', async () => {
  const state = {};
  const r = await run({ due: { campaign: CAMP, at: '2026-10-01 11:55', channel: 'UCx' } }, state);
  assert.deepEqual(r.calls, ['publish due', 'submit due']);
  assert.ok(state.due.published && state.due.submitted && !state.due.error);
  assert.equal(state.due.whop_receipt.receipt_id, 'sub_1');
  assert.equal(state.due.whop_receipt.campaign_id, CAMP);
  assert.equal(state.due.whop_receipt.post_url, 'https://www.youtube.com/watch?v=due');
});

await test('not due: a held clip before its slot is left alone', async () => {
  const state = {};
  const r = await run({ later: { campaign: CAMP, at: '2026-10-01 12:30', channel: 'UCx' } }, state);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(state, {});
});

await test('early: a held clip made public before its slot is submitted without another publish', async () => {
  publicVids = new Set(['early']);
  const state = {};
  const r = await run({ early: { campaign: CAMP, at: '2026-10-02 18:00', channel: 'UCx' } }, state);
  assert.deepEqual(r.calls, ['submit early']);
  assert.ok(state.early.published && state.early.submitted);
  publicVids = new Set();
});

await test('existing public clips keep the actual time even after the saved slot, never another publish', async () => {
  publicVids = new Set(['manualDue', 'expiredManual']);
  publishedDates.set('expiredManual', now - 31 * 60000);
  const state = {};
  const r = await run({ manualDue: { campaign: CAMP, at: '2026-10-01 11:50', channel: 'UCx' }, expiredManual: { campaign: CAMP, at: '2026-10-02 12:00', channel: 'UCx' } }, state);
  assert.deepEqual(r.calls, ['submit manualDue']);
  assert.equal(Date.parse(state.manualDue.published), now - 60000);
  assert.equal(Date.parse(state.expiredManual.published), now - 31 * 60000);
  assert.ok(!state.expiredManual.submitted);
  publicVids = new Set(); publishedDates.clear();
});

await test('gap: two due clips on one channel go out GAP apart, not together', async () => {
  const queue = { p1: { campaign: CAMP, at: '2026-10-01 08:00', channel: 'UCx' }, p2: { campaign: CAMP, at: '2026-10-01 09:00', channel: 'UCx' } };
  const state = {};
  let r = await run(queue, state);
  assert.deepEqual(r.calls, ['publish p1', 'submit p1']);
  assert.ok(!state.p2);
  r = await run(queue, state, now + GAP - 60e3);
  assert.deepEqual(r.calls, [], 'still inside GAP');
  r = await run(queue, state, now + GAP);
  assert.deepEqual(r.calls, ['publish p2', 'submit p2']);
});

await test('30-minute rule: public for over 30 min is never submitted', async () => {
  publicVids = new Set(['old', 'stale']);
  const state = { stale: { campaign: CAMP, published: new Date(now - 40 * 60e3).toISOString() } }; // published, submit failed back then
  const r = await run({ old: { campaign: CAMP, at: '2026-10-01 11:15' },                              // Studio-scheduled, 45 min ago
                        stale: { campaign: CAMP, at: '2026-10-01 11:20', channel: 'UCx' } }, state);
  assert.deepEqual(r.calls, []);
});

await test('in window: a Studio-scheduled clip that went public 10 min ago is submitted', async () => {
  publicVids = new Set(['sched']);
  const state = {};
  const r = await run({ sched: { campaign: CAMP, at: '2026-10-01 11:50' } }, state);
  assert.deepEqual(r.calls, ['submit sched']);
});

await test('API refused (YouTube): publish 403 -> not published, not submitted, retried next pass', async () => {
  ytPutFail = new Set(['nope']);
  const state = {};
  const r = await run({ nope: { campaign: CAMP, at: '2026-10-01 11:00', channel: 'UCx' } }, state);
  assert.deepEqual(r.calls, ['publish nope']);
  assert.ok(!state.nope?.published);
  ytPutFail = new Set();
  assert.deepEqual((await run({ nope: { campaign: CAMP, at: '2026-10-01 11:00', channel: 'UCx' } }, state)).calls, ['publish nope', 'submit nope']);
});

await test('API refused (YouTube token revoked): run fails loudly', async () => {
  const r = await run({ y: { campaign: CAMP, at: '2026-10-01 11:00', channel: 'UCy' } }, {});
  assert.deepEqual(r.calls, []);
  assert.match(r.fatal.join(), /UCy failed: 400 invalid_grant/);
});

await test('API refused (Content Rewards): refusal kept as error, not marked submitted', async () => {
  crResult = { ref: { code: 'BAD_REQUEST', error: 'Posts have to be submitted within 30 minutes', success: false } };
  const state = {};
  const r = await run({ ref: { campaign: CAMP, at: '2026-10-01 11:59', channel: 'UCx' } }, state);
  assert.deepEqual(r.calls, ['publish ref', 'submit ref']);
  assert.ok(!state.ref.submitted);
  assert.match(state.ref.error, /refused: BAD_REQUEST/);
  assert.deepEqual(r.fatal, []);
});

await test('dead Whop session or Cloudflare challenge: nothing is published, run fails loudly', async () => {
  for (session of ['unauth', 'cf']) {
    const state = {};
    const r = await run({ h1: { campaign: CAMP, at: '2026-10-01 11:50', channel: 'UCx' }, h2: { campaign: CAMP, at: '2026-10-01 11:55', channel: 'UCx2' } }, state);
    // A 401 on the REST session check tries one refreshSession first; nothing may be published or submitted.
    assert.deepEqual(r.calls.filter(c => c !== 'refresh'), [], 'a clip went public that could not be submitted');
    assert.equal(r.checks, 1, 'the session is checked once per run');
    assert.deepEqual(state, {});
    assert.match(r.fatal.join(), session === 'cf' ? /whop session: blocked \(HTTP 403 challenge\)/ : /whop session: HTTP 401 NOT_AUTHORIZED/);
  }
  session = 'ok';
});

await test('stale REST access cookie: 401 -> refreshSession -> retried once with the fresh cookie -> submitted', async () => {
  assert.equal(mergeCookies('a=1; __Host-cr-session=old', ['__Host-cr-session=new; Path=/', 'b=2; HttpOnly']), 'a=1; __Host-cr-session=new; b=2');
  crResult = { st: { stale: true } };
  const state = {};
  const r = await run({ st: { campaign: CAMP, at: '2026-10-01 11:59', channel: 'UCx' } }, state);
  assert.deepEqual(r.calls, ['publish st', 'submit st', 'refresh', 'submit st']);
  assert.ok(state.st.submitted && !state.st.error, JSON.stringify(state.st));
  assert.deepEqual(r.fatal, []);
});

await test('session dies between the check and the submit: run fails loudly', async () => {
  crResult = { un: { code: 'NOT_AUTHORIZED', error: 'Authentication required', success: false }, cf: { cf: true } };
  const state = {};
  const r = await run({ un: { campaign: CAMP, at: '2026-10-01 11:59', channel: 'UCx' }, cf: { campaign: CAMP, at: '2026-10-01 11:58', channel: 'UCx2' } }, state);
  assert.match(state.un.error, /unauthorized/);
  assert.equal(r.fatal.length >= 2, true, r.fatal.join());
  assert.match(r.fatal.join(), /blocked: HTTP 403 challenge/);
});

await test('duplicate: Content Rewards says already submitted -> recorded as submitted, never retried', async () => {
  crResult = { dup: { code: 'CONFLICT', error: 'This post is already submitted to this campaign. Pick a different post.', kind: 'duplicate-post', success: false } };
  const state = {};
  await run({ dup: { campaign: CAMP, at: '2026-10-01 11:59', channel: 'UCx' } }, state);
  assert.ok(state.dup.submitted);
  assert.equal(state.dup.note, 'duplicate');
  publicVids = new Set(['dup']);
  assert.deepEqual((await run({ dup: { campaign: CAMP, at: '2026-10-01 11:59', channel: 'UCx' } }, state)).calls, []);
  crResult = {};
});

await test('duplicate: current already been submitted wording clears the stale failure', async () => {
  crResult = { dupBeen: { code: 'CONFLICT', error: 'This post has already been submitted to the campaign', success: false } };
  publicVids = new Set(['dupBeen']);
  const state = { dupBeen: { campaign: CAMP, published: new Date(now - 60000).toISOString(), error: 'old failure' } };
  const queue = { dupBeen: { campaign: CAMP, at: '2026-10-01 11:59' } };
  await run(queue, state);
  assert.ok(state.dupBeen.submitted);
  assert.equal(state.dupBeen.note, 'duplicate');
  assert.ok(!state.dupBeen.error);
  assert.deepEqual((await run(queue, state)).calls, []);
  crResult = {}; publicVids = new Set();
});

await test("publish time not confirmed yet: retried in the same run, then submitted", async () => {
  const msg = "Unable to confirm the post's publish time";
  crResult = { pt: { code: 'CONFLICT', error: msg, success: false, times: 2 }, never: { code: 'CONFLICT', error: msg, success: false } };
  const state = {};
  const r = await run({ pt: { campaign: CAMP, at: '2026-10-01 11:59', channel: 'UCx' } }, state);
  assert.deepEqual(r.calls, ['publish pt', 'submit pt', 'wait', 'submit pt', 'wait', 'submit pt']);
  assert.ok(state.pt.submitted && !state.pt.error);
  const s2 = {};
  const r2 = await run({ never: { campaign: CAMP, at: '2026-10-01 11:59', channel: 'UCx' } }, s2);
  assert.deepEqual(r2.calls, ['publish never', 'submit never', 'wait', 'submit never', 'wait', 'submit never']);
  assert.match(s2.never.error, /refused: CONFLICT/);
  crResult = {};
});

await test('feed backstop: an unqueued Charisma Tape upload public 5 min ago is submitted to Sartain', async () => {
  feedXml = `<feed><entry><yt:videoId>fresh</yt:videoId><published>${new Date(now - 5 * 60e3).toISOString()}</published></entry>
             <entry><yt:videoId>older</yt:videoId><published>${new Date(now - 45 * 60e3).toISOString()}</published></entry></feed>`;
  const r = await run({}, {});
  assert.deepEqual(r.calls, ['submit fresh']);
  feedXml = '';
});

await test('cap: a campaign at maxSubmissionsPerUser, or paused, keeps its clips private', async () => {
  campaignStatus = { capped: { cap: 1 }, paused: { status: 'paused' } };
  const state = { a: { campaign: 'capped', submitted: '2026-10-01T00:00:00Z' } };
  const r = await run({ b: { campaign: 'capped', at: '2026-10-01 11:59', channel: 'UCx' }, c: { campaign: 'paused', at: '2026-10-01 11:58', channel: 'UCx2' } }, state);
  assert.deepEqual(r.calls, []); // never published: publishing would burn the 30-minute window (TIyZahZmFZE, 2026-10-02)
  assert.ok(!state.b?.published && !state.c?.published);
});

await test('cap: a failed campaign lookup holds the clip private (AftPinWeR88, 2026-10-14)', async () => {
  campaignStatus = { broken: { broken: true } };
  const state = {};
  const r = await run({ d: { campaign: 'broken', at: '2026-10-01 11:57', channel: 'UCx' } }, state);
  assert.deepEqual(r.calls, []);
  assert.ok(!state.d?.published);
  campaignStatus = {};
});

await test('laptop fallback did it: a clip in laptop-state.json is not published or submitted again', async () => {
  publicVids = new Set(['lap', 'lap2']);
  const queue = { lap: { campaign: CAMP, at: '2026-10-01 11:40', channel: 'UCx' }, lap2: { campaign: CAMP, at: '2026-10-01 11:45', channel: 'UCx2' } };
  const state = mergeLaptop({ lap2: { campaign: CAMP, error: 'blocked: HTTP 403 challenge' } }, {
    lap: { campaign: CAMP, published: new Date(now - 5 * 60e3).toISOString(), submitted: new Date(now - 4 * 60e3).toISOString() },
    lap2: { campaign: CAMP, published: new Date(now - 60e3).toISOString(), submitted: new Date(now - 30e3).toISOString() } });
  const r = await run(queue, state);
  assert.deepEqual(r.calls, []);
  assert.ok(state.lap2.submitted && state.lap2.error, 'merge keeps both the cloud error and the laptop submit');
});

await test('social: TikTok and Instagram posts are submitted with their own URL inside 30 min; TikTok waits until live', async () => {
  const TT = 'https://www.tiktok.com/@offmicmma/video/111', IG = 'https://www.instagram.com/reel/AbC-1/';
  assert.deepEqual(socialEntry('https://www.instagram.com/bloxluckclips/reel/AbC-1/?x=1'), { key: 'ig:AbC-1', platform: 'instagram', url: IG });
  assert.equal(socialEntry(TT).key, 'tt:111');
  const queue = { 'tt:111': { campaign: CAMP, at: '2026-10-01 11:50', platform: 'tiktok', url: TT, clip: 'yt1' },
                  'ig:AbC-1': { campaign: CAMP, at: '2026-10-01 11:55', platform: 'instagram', url: IG, clip: 'yt1' },
                  'tt:222': { campaign: CAMP, at: '2026-10-01 11:20', platform: 'tiktok', url: 'https://www.tiktok.com/@offmicmma/video/222' } };
  publicVids = new Set(['tt:222']); // 111 not live yet (scheduled), 222 live but 40 min old
  const state = {};
  let r = await run(queue, state);
  assert.deepEqual(r.calls, [`url ${IG}`, 'submit ig:AbC-1']);
  assert.ok(state['ig:AbC-1'].submitted && !state['tt:111'] && !state['tt:222']);
  publicVids = new Set(['tt:111', 'tt:222']);
  r = await run(queue, state);
  assert.deepEqual(r.calls, [`url ${TT}`, 'submit tt:111']);
  assert.deepEqual((await run(queue, state)).calls, [], 'never submitted twice');
  publicVids = new Set(); // TikTok oEmbed blocked from the runner: a laptop-queued live post still goes in
  const live = { 'tt:333': { campaign: CAMP, at: '2026-10-01 11:58', platform: 'tiktok', url: 'https://www.tiktok.com/@offmicmma/video/333', live: true } };
  assert.deepEqual((await run(live, {})).calls, ['url https://www.tiktok.com/@offmicmma/video/333', 'submit tt:333']);
});

await test('tiktok native schedule: submit-only entry goes in from slot + 2 min even with oEmbed blocked, never early or late', async () => {
  const U = 'https://www.tiktok.com/@112skuba/video/444';
  const q = () => ({ 'tt:444': { campaign: CAMP, at: '2026-10-01 11:58', platform: 'tiktok', url: U, scheduled: true } });
  publicVids = new Set();
  assert.deepEqual((await run(q(), {}, now - 60e3)).calls, [], 'before slot + 2 min: waits');
  const state = {};
  assert.deepEqual((await run(q(), state, now + 60e3)).calls, [`url ${U}`, 'submit tt:444']);
  assert.ok(state['tt:444'].submitted, 'state recorded like YouTube items');
  assert.deepEqual((await run(q(), state, now + 120e3)).calls, [], 'never twice');
  assert.deepEqual((await run(q(), {}, slot('2026-10-01 11:58') + 31 * 60e3)).calls, [`url ${U}`, 'submit tt:444'], 'still under review at 31 min: keeps trying');
  assert.deepEqual((await run(q(), {}, slot('2026-10-01 11:58') + 181 * 60e3)).calls, [], 'past the 3-h TikTok window: skipped');
  publicVids = new Set(['tt:444']); // oEmbed answers: go in at the slot itself
  assert.deepEqual((await run(q(), {}, slot('2026-10-01 11:58'))).calls, [`url ${U}`, 'submit tt:444']);
  publicVids = new Set();
  crResult['tt:444'] = { code: 'VALIDATION', error: "We couldn't read that from the platform.", success: false };
  const unread = {};
  assert.deepEqual((await run(q(), unread, slot('2026-10-01 11:58') + 20 * 60e3)).fatal, [], 'unreadable at 20 min: no alert yet');
  assert.match((await run(q(), unread, slot('2026-10-01 11:58') + 31 * 60e3)).fatal.join(), /can't read this TikTok after 31 min; repost/);
  assert.deepEqual((await run(q(), unread, slot('2026-10-01 11:58') + 46 * 60e3)).fatal, [], 'alerts once');
  delete crResult['tt:444'];
});

await test('API queue entries never enter the legacy social/YouTube pass', async () => {
  const r = await run({ 'igs:one': { mode: 'api', platform: 'instagram', campaign: CAMP, at: '2026-10-01 11:55' } }, {});
  assert.deepEqual(r.calls, []);
});

const realIG = { ...net.ig }, realSubmit = net.submit, realWhop = net.whopCheck, realCap = net.cap;
const igQueue = { 'igs:one': { platform: 'instagram', mode: 'api', campaign: CAMP, at: '2026-10-01 12:00', asset: 'one.mp4', caption: 'Which one?', slug: 'one', yt: 'yt1' } };
const igURL = 'https://www.instagram.com/reel/AbC-1/';
let igCalls, igStatus, igSubmit, igSession, igOpen, username, refreshed, snapshots, tmpFiles;
function resetIG() {
  process.env.IG_TOKEN = 'offline-ig-token';
  igCalls = []; igStatus = 'FINISHED'; igSubmit = { stage: 'submitted' }; igSession = 'ok'; igOpen = true;
  username = 'bloxluckclips'; refreshed = { access_token: process.env.IG_TOKEN, expires_in: 60 * 86400 }; snapshots = []; tmpFiles = [];
  net.cap = async () => igOpen ? null : 0;
  net.whopCheck = async () => { igCalls.push('whop'); return igSession; };
  net.submit = async (key, campaign, url) => {
    igCalls.push('submit');
    assert.equal(key, 'igs:one'); assert.equal(campaign, CAMP); assert.equal(url, igURL);
    assert.ok(snapshots.some(s => s[key]?.published && s[key]?.url === url), 'save permalink before submit');
    return igSubmit;
  };
  net.ig = {
    me: async () => { igCalls.push('me'); return { user_id: 'u1', username }; },
    refresh: async () => { igCalls.push('refresh'); return refreshed; },
    limit: async () => { igCalls.push('limit'); return { data: [{ quota_usage: 2, config: { quota_total: 100 } }] }; },
    link: async asset => { igCalls.push('link'); assert.equal(asset, 'one.mp4'); return 'https://signed.example/one.mp4'; },
    create: async (id, caption, url) => { igCalls.push('create'); assert.equal(id, 'u1'); assert.equal(caption, 'Which one?'); assert.equal(url, 'https://signed.example/one.mp4'); return { id: 'c1' }; },
    status: async () => { igCalls.push('status'); return { status_code: igStatus }; },
    publish: async (id, container) => { igCalls.push('publish'); assert.equal(id, 'u1'); assert.equal(container, 'c1'); return { id: 'm1' }; },
    permalink: async () => { igCalls.push('permalink'); return { permalink: igURL }; },
    deleteAsset: async () => { igCalls.push('delete'); },
  };
}
async function runIG(state = {}, t = now, options = {}, queue = igQueue) {
  const logs = [];
  const io = { log: m => logs.push(m), fatal: [], save: () => snapshots.push(structuredClone(state)), ...options };
  await igPass(queue, state, t, io);
  return { state, logs, io };
}
const containerState = () => ({ 'igs:one': { campaign: CAMP, container: 'c1' } });

await test('IG stages at -40 minutes, not -41; deletes its temporary file', async () => {
  resetIG(); const state = {};
  await runIG(state, now - 41 * 60e3);
  assert.deepEqual(igCalls, ['me']);
  igCalls = [];
  await runIG(state, now - 40 * 60e3);
  assert.deepEqual(igCalls, ['me', 'link', 'create']);
  assert.equal(state['igs:one'].container, 'c1'); assert.ok(state['igs:one'].staged);
  assert.ok(tmpFiles.every(f => !existsSync(f)));
});
await test('IG FINISHED publishes at the slot, saves then submits the permalink', async () => {
  resetIG(); const state = containerState();
  await runIG(state, now - 1); assert.ok(!igCalls.includes('publish'));
  igCalls = [];
  await runIG(state);
  assert.deepEqual(igCalls, ['me', 'whop', 'status', 'publish', 'permalink', 'submit', 'delete']);
  assert.equal(state['igs:one'].url, igURL); assert.ok(state['igs:one'].submitted);
});
await test('IG IN_PROGRESS waits', async () => {
  resetIG(); igStatus = 'IN_PROGRESS';
  const r = await runIG(containerState());
  assert.ok(!igCalls.includes('publish')); assert.ok(r.logs.some(l => l.includes('IN_PROGRESS')));
});
await test('IG ERROR retries; third failure sets failed and fatal; EXPIRED follows the same path', async () => {
  for (const status of ['ERROR', 'EXPIRED']) {
    resetIG(); igStatus = status; const state = containerState();
    for (let i = 1; i <= 3; i++) {
      const r = await runIG(state);
      assert.equal(state['igs:one'].tries, i); assert.ok(!state['igs:one'].container);
      assert.equal(r.io.fatal.length, i === 3 ? 1 : 0);
    }
    assert.equal(state['igs:one'].failed, status);
    igCalls = []; await runIG(state); assert.deepEqual(igCalls, ['me']);
  }
});
await test('IG respects a 60-minute gap across all igs state records', async () => {
  resetIG(); const state = { ...containerState(), 'igs:previous': { published: new Date(now - 59 * 60e3).toISOString() } };
  await runIG(state); assert.ok(!igCalls.includes('publish'));
  await runIG(state, now + 60e3); assert.ok(igCalls.includes('publish'));
});
await test('IG closed campaign never stages or publishes an existing container', async () => {
  resetIG(); igOpen = false;
  await runIG(); await runIG(containerState());
  assert.ok(!igCalls.includes('create') && !igCalls.includes('publish'));
});
await test('IG bad Whop session prevents publication; session cache is shared', async () => {
  resetIG(); igSession = 'UNAUTHORIZED';
  let r = await runIG(containerState());
  assert.ok(!igCalls.includes('publish')); assert.match(r.io.fatal.join(), /whop session/);
  igCalls = []; r = await runIG(containerState(), now, { whop: 'blocked' });
  assert.ok(!igCalls.includes('whop') && !igCalls.includes('publish'));
});
await test('IG no token makes no calls and logs once', async () => {
  resetIG(); delete process.env.IG_TOKEN;
  const state = {}, r = await runIG(state);
  assert.deepEqual(igCalls, []); assert.deepEqual(state, {});
  assert.deepEqual(r.logs, ['instagram api: IG_TOKEN not set, skipping 1 entries']);
});
await test('IG dry run reads identity/quota, prints both plans and never mutates', async () => {
  resetIG(); const state = {}, r = await runIG(state, now, { dry: true });
  assert.deepEqual(igCalls, ['me', 'limit', 'whop']); assert.deepEqual(state, {}); assert.deepEqual(snapshots, []);
  assert.ok(r.logs.includes('instagram api: user bloxluckclips, publishing limit 2/100'));
  assert.ok(r.logs.some(l => l.startsWith('would stage')) && r.logs.some(l => l.startsWith('would publish')));
});
await test('IG wrong account fails before upload or refresh', async () => {
  resetIG(); username = 'someoneelse';
  await assert.rejects(runIG(), /IG_TOKEN is for someoneelse, not bloxluckclips/);
  assert.deepEqual(igCalls, ['me']);
});
await test('IG token age warns from day 50 by hash, never leaking the token; a new token resets the clock', async () => {
  resetIG(); const state = {};
  let r = await runIG(state, now - 41 * 60e3);
  assert.equal(r.io.fatal.length, 0); assert.equal(state._igtoken.since, new Date(now - 41 * 60e3).toISOString().replace('.000Z', 'Z'));
  assert.doesNotMatch(JSON.stringify(state), /offline-ig-token/);
  r = await runIG(state, now - 41 * 60e3 + 50 * 864e5);
  assert.match(r.io.fatal.join(), /50 days old.*gh secret set IG_TOKEN/); assert.doesNotMatch(r.io.fatal.join(), /offline-ig-token/);
  process.env.IG_TOKEN = 'rotated-secret';
  r = await runIG(state, now - 41 * 60e3 + 51 * 864e5);
  assert.equal(r.io.fatal.length, 0); assert.doesNotMatch(JSON.stringify(state), /rotated-secret/);
});
await test('IG refused submit retries once per run through 30 min; no duplicate publish', async () => {
  resetIG(); igSubmit = { stage: 'refused', error: 'reader lag' }; const state = containerState();
  await runIG(state); assert.ok(!state['igs:one'].submitted);
  igCalls = []; await runIG(state, now + 20 * 60e3);
  assert.equal(igCalls.filter(x => x === 'submit').length, 1); assert.ok(!igCalls.includes('publish'));
  igCalls = []; await runIG(state, now + 31 * 60e3); assert.ok(!igCalls.includes('submit'));
  igSubmit = { stage: 'submitted', note: 'duplicate' }; await runIG(state, now + 30 * 60e3);
  assert.equal(state['igs:one'].note, 'duplicate'); assert.ok(!state['igs:one'].error);
});
await test('IG unauthorized/blocked submit is fatal; asset deletion failure is only logged', async () => {
  for (const stage of ['unauthorized', 'blocked']) {
    resetIG(); igSubmit = { stage, error: 'session' }; net.ig.deleteAsset = async () => { throw new Error('cleanup refused'); };
    const r = await runIG(containerState());
    assert.equal(r.io.fatal.length, 1); assert.match(r.io.fatal[0], new RegExp(stage));
    assert.ok(r.logs.some(l => l.includes('asset cleanup failed')));
  }
});
await test('IG missing permalink recovers media id without another publish; uncertain publish holds', async () => {
  resetIG(); const state = containerState(), link = net.ig.permalink;
  net.ig.permalink = async () => { throw new Error('lookup unavailable'); };
  await runIG(state); assert.equal(state['igs:one'].media_id, 'm1'); assert.ok(state['igs:one'].published);
  igCalls = []; net.ig.permalink = link; await runIG(state, now + 20 * 60e3);
  assert.ok(!igCalls.includes('publish')); assert.ok(state['igs:one'].submitted);
  resetIG(); net.ig.publish = async () => { throw new Error('connection lost'); };
  const uncertain = containerState(); await runIG(uncertain); assert.ok(uncertain['igs:one'].publishing);
  igCalls = []; const r = await runIG(uncertain); assert.ok(!igCalls.includes('publish'));
  assert.match(r.io.fatal.join(), /reconciliation/);
  resetIG(); igStatus = 'PUBLISHED'; const already = await runIG(containerState());
  assert.ok(!igCalls.includes('publish')); assert.match(already.io.fatal.join(), /reconciliation/);
});
await test('IG stage deadline and create failure', async () => {
  resetIG(); await runIG({}, now + 6 * 3600e3 + 1); assert.ok(!igCalls.includes('create'));
  resetIG(); net.ig.create = async () => ({});
  const r = await runIG(); assert.ok(!r.state['igs:one'].container && r.io.fatal.length);
});
await test('IG HTTP adapters use v26 Instagram Login paths, form fields and safe errors', async () => {
  const previousFetch = globalThis.fetch;
  process.env.IG_TOKEN = 'offline-ig-token';
  const requests = [];
  globalThis.fetch = async (url, opt = {}) => { requests.push([String(url), opt]); return json({ id: 'x', success: true }); };
  try {
    await realIG.me(); await realIG.create('u1', 'hello & world', 'https://signed.example/v.mp4'); await realIG.status('c1');
    await realIG.publish('u1', 'c1'); await realIG.permalink('m1'); await realIG.limit('u1'); await realIG.refresh();
    assert.equal(IG_VERSION, 'v26.0'); assert.match(requests[0][0], /graph.instagram.com\/v26.0\/me\?fields=user_id%2Cusername/);
    const create = requests[1]; assert.equal(create[1].body.get('video_url'), 'https://signed.example/v.mp4'); assert.equal(create[1].body.get('upload_type'), null); assert.equal(create[1].body.get('caption'), 'hello & world');
    assert.equal(create[1].body.get('media_type'), 'REELS'); assert.equal(create[1].body.get('share_to_feed'), 'true');
    assert.equal(requests[3][1].body.get('creation_id'), 'c1'); assert.match(requests[6][0], /refresh_access_token\?grant_type=ig_refresh_token/);
    globalThis.fetch = async () => json({ error: { code: 190, error_subcode: 1, message: 'expired offline-ig-token' } }, 400);
    await assert.rejects(realIG.me(), e => /HTTP 400: 190\/1 expired \[redacted\]/.test(e.message) && !e.message.includes(process.env.IG_TOKEN));
    globalThis.fetch = async () => { throw new Error('url contains offline-ig-token'); };
    await assert.rejects(realIG.refresh(), /instagram HTTP unavailable/);
  } finally { globalThis.fetch = previousFetch; }
});
net.ig = realIG; net.submit = realSubmit; net.whopCheck = realWhop; net.cap = realCap;
delete process.env.IG_TOKEN;
console.log(`selftest ok: ${cases} cases`);
