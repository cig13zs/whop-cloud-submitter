#!/usr/bin/env node
// Whop scoreboard: what every recent clip on a mapped channel is worth, with no login and no LLM tokens.
// Reads the local plaintext channel-map.json (node crypt.mjs open), each channel's public RSS feed (views, likes)
// and the public Content Rewards campaign API (rate, minimum, budget). Never run in CI: it prints ids.
//   node scoreboard.mjs [--days 7] [--out <file.md>] [--log <file.jsonl>]
// ponytail: RSS holds a channel's newest 15 videos and only their current counts, so history comes from the --log
// snapshots this writes on each run. Move collection into the cloud runner if the laptop is off too often.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CHANNEL_MAP, campaignFor } from './run.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DAYS = +arg('--days', 7), OUT = arg('--out', ''), LOG = arg('--log', ''), now = Date.now();
Object.assign(CHANNEL_MAP, JSON.parse(readFileSync(path.join(DIR, 'channel-map.json'), 'utf8')).channels || {});

const campaigns = {};
async function campaign(id) {
  if (campaigns[id]) return campaigns[id];
  const d = (await (await fetch(`https://contentrewards.com/api/campaign/campaigns/${id}`)).json()).data || {};
  const yt = (d.configuration?.payoutModel || []).find(p => p.platform === 'youtube');
  return campaigns[id] = { id, name: (d.name || id.slice(0, 8)).slice(0, 28), status: d.status || 'unknown', rate: yt?.rate || 0,
    minViews: yt?.rate ? Math.round(yt.minPayout / yt.rate * 1000) : 0, maxPay: (yt?.maxPayout || 0) / 100,
    left: Math.round(((d.configuration?.budget || 0) - (d.metrics?.budgetSpentCents || 0)) / 100) };
}

const clips = [], channels = [];
for (const channel of Object.keys(CHANNEL_MAP)) {
  const xml = await (await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`)).text();
  const name = xml.match(/<title>([^<]*)/)?.[1] || channel;
  const all = xml.split('<entry>').slice(1).map(e => ({ channel: name, vid: e.match(/<yt:videoId>([^<]+)/)?.[1], at: Date.parse(e.match(/<published>([^<]+)/)?.[1]),
    title: (e.match(/<title>([^<]*)/)?.[1] || '').replace(/&amp;/g, '&'), views: +(e.match(/<media:statistics views="(\d+)"/)?.[1] || 0), likes: +(e.match(/<media:starRating count="(\d+)"/)?.[1] || 0),
    campaignId: campaignFor(channel, `${e.match(/<title>([^<]*)/)?.[1] || ''} ${e.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] || ''}`) }));
  const settled = all.filter(c => now - c.at > 48 * 3600e3).map(c => c.views).sort((a, b) => a - b);
  const median = settled.length ? settled[Math.floor(settled.length / 2)] : 0;
  channels.push({ name, median, n: all.length });
  for (const c of all.filter(c => now - c.at <= DAYS * 864e5)) clips.push({ ...c, median });
}
for (const c of clips) {
  const k = c.campaignId ? await campaign(c.campaignId) : null;
  c.campaign = k?.name || 'NO RULE MATCHED';
  c.ageH = Math.round((now - c.at) / 3600e3);
  c.pay = k && c.views >= k.minViews ? Math.min(c.views * k.rate / 100 / 1000, k.maxPay) : 0;
  c.state = !k ? 'UNROUTED' : k.status !== 'active' ? 'CAMPAIGN ' + k.status.toUpperCase() : c.median && c.views >= 5 * c.median && c.views >= 3000 ? 'BREAKOUT' : c.pay ? 'pays' : c.ageH < 48 ? 'young' : 'below min';
}
if (LOG) appendFileSync(LOG, clips.map(c => JSON.stringify({ ts: new Date(now).toISOString(), vid: c.vid, channel: c.channel, campaign: c.campaign, ageH: c.ageH, views: c.views, likes: c.likes })).join('\n') + (clips.length ? '\n' : ''));

const by = {};
for (const c of clips) { const g = by[c.campaign] ??= { n: 0, paying: 0, pay: 0, views: 0 }; g.n++; g.paying += c.pay > 0; g.pay += c.pay; g.views += c.views; }
const settledDead = (name, ch) => clips.filter(c => c.campaign === name && c.channel === ch && c.ageH >= 48);
const actions = [];
for (const c of clips.filter(c => c.state === 'BREAKOUT')) actions.push(`DOUBLE DOWN: "${c.title.slice(0, 50)}" on ${c.channel} hit ${c.views} views (${Math.round(c.views / c.median)}x the channel median). Make 2 more with the same opening and moment type within 24 h.`);
for (const key of new Set(clips.map(c => c.campaign + '|' + c.channel))) {
  const [name, ch] = key.split('|'), old = settledDead(name, ch);
  if (old.length >= 5 && !old.some(c => c.pay > 0)) actions.push(`CHANGE OR DROP: ${name} on ${ch}: ${old.length} clips past 48 h and none cleared the minimum. Change the first 2 seconds or move the slot to a better campaign.`);
}
for (const k of Object.values(campaigns)) {
  if (k.status !== 'active') actions.push(`STOP: ${k.name} is ${k.status}. Post nothing more for it.`);
  else if (k.left < 300) actions.push(`WIND DOWN: ${k.name} has $${k.left} left. Use up ready clips, make no new ones.`);
}
const md = [`# Whop scoreboard ${new Date(now).toISOString().slice(0, 16)}Z (last ${DAYS} days, YouTube, estimated pay if approved)`, '',
  '| campaign | clips | paying | est $ | views | $ left |', '|---|---:|---:|---:|---:|---:|',
  ...Object.entries(by).sort((a, b) => b[1].pay - a[1].pay).map(([n, g]) => `| ${n} | ${g.n} | ${g.paying} | ${g.pay.toFixed(2)} | ${g.views} | ${Object.values(campaigns).find(k => k.name === n)?.left ?? '-'} |`),
  `| **total** | ${clips.length} | ${clips.filter(c => c.pay).length} | ${clips.reduce((s, c) => s + c.pay, 0).toFixed(2)} | ${clips.reduce((s, c) => s + c.views, 0)} | |`, '',
  '## Actions', ...(actions.length ? actions.map(a => '- ' + a) : ['- none']), '',
  '## Clips', '| age h | views | like % | state | channel | campaign | title |', '|---:|---:|---:|---|---|---|---|',
  ...clips.sort((a, b) => a.ageH - b.ageH).map(c => `| ${c.ageH} | ${c.views} | ${c.views ? (100 * c.likes / c.views).toFixed(1) : '-'} | ${c.state} | ${c.channel.slice(0, 20)} | ${c.campaign} | ${c.title.slice(0, 48)} |`), '',
  '## Channels (median views of clips older than 48 h)', ...channels.map(c => `- ${c.name}: ${c.median || 'no settled clips'}`)].join('\n') + '\n';
if (OUT) writeFileSync(OUT, md); else console.log(md);
