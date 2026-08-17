import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const known = require('../data/arknights-operators.js');
const MAIN_URL = 'https://prts.wiki/w/%E5%B9%B2%E5%91%98%E4%B8%80%E8%A7%88';
const RELEASE_URL = 'https://prts.wiki/w/%E5%B9%B2%E5%91%98%E4%B8%8A%E7%BA%BF%E6%97%B6%E9%97%B4%E4%B8%80%E8%A7%88';
const mainFile = path.join(ROOT, 'data', 'prts-operators.html');
const releaseFile = path.join(ROOT, 'data', 'prts-operator-release-dates.html');

const ALTER_NAMES = {
  '百炼嘉维尔': '嘉维尔', '承曦格雷伊': '格雷伊', '赤刃明霄陈': '陈', '纯烬艾雅法拉': '艾雅法拉',
  '淬羽赫默': '赫默', '涤火杰西卡': '杰西卡', '归溟幽灵鲨': '幽灵鲨', '寒芒克洛丝': '克洛丝',
  '荒芜拉普兰德': '拉普兰德', '火龙S黑角': '黑角', '假日威龙陈': '陈', '缄默德克萨斯': '德克萨斯',
  '酒神': '傀影', '凯尔希·思衡托': '凯尔希', '雷狼龙S空爆': '空爆', '历阵锐枪芬': '芬',
  '琳琅诗怀雅': '诗怀雅', '凛御银灰': '银灰', '怒潮凛冬': '凛冬', '麒麟R夜刀': '夜刀',
  '圣聆初雪': '初雪', '圣约送葬人': '送葬人', '司霆惊蛰': '惊蛰', '溯光星源': '星源',
  '维娜·维多利亚': '推进之王', '维什戴尔': 'W', '撷英调香师': '调香师', '新约能天使': '能天使',
  '焰狐龙梓兰': '梓兰', '焰影苇草': '苇草', '炎狱炎熔': '炎熔', '耀骑士临光': '临光',
  '引星棘刺': '棘刺', '予愿安洁莉娜': '安洁莉娜', '斩业星熊': '星熊', '烛煌': '煌',
  '濯尘芙蓉': '芙蓉', '浊心斯卡蒂': '斯卡蒂'
};

const htmlDecode = value => String(value || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&#x2F;/gi, '/')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/\s+/g, ' ')
  .trim();

const attr = (tag, name) => {
  const match = String(tag).match(new RegExp(`\\bdata-${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return htmlDecode(match?.[1] || '');
};

async function readOrFetch(file, url, force = false) {
  if (!force) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Friberg-Arknights-Data-Sync/2.0' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`PRTS request failed: HTTP ${response.status}`);
  const html = await response.text();
  await fs.writeFile(file, html, 'utf8');
  return html;
}

function slug(value) {
  return String(value).toLowerCase().replace(/%[0-9a-f]{2}/gi, '').replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'operator';
}

function parseReleaseTimeline(html) {
  const releases = new Map();
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => htmlDecode(match[1]));
    if (cells.length < 3) continue;
    const name = cells[0];
    const rarity = Number(cells[1]);
    const yearMatch = cells[2].match(/(20\d{2})\s*年/);
    if (!name || !Number.isInteger(rarity) || !yearMatch) continue;
    const release = { rarity, year: Number(yearMatch[1]) };
    const previous = releases.get(name);
    if (previous && (previous.rarity !== release.rarity || previous.year !== release.year)) {
      throw new Error(`PRTS release timeline has conflicting records for ${name}`);
    }
    releases.set(name, release);
  }
  if (releases.size < 400) throw new Error(`Only parsed ${releases.size} PRTS release records`);
  return releases;
}

function positionFor(rawPosition, subclass, name) {
  if (subclass === '推击手' || subclass === '钩索师') return ['地面', '高台'];
  if (rawPosition === '远程位') return ['高台'];
  if (rawPosition === '近战位') return ['地面'];
  throw new Error(`${name} has an unknown PRTS position: ${rawPosition || '(empty)'}`);
}

function parseMainRoster(html, releases) {
  const tags = [...html.matchAll(/<[^>]+data-zh=["'][^"']+["'][^>]*>/gi)].map(match => match[0]);
  const records = [];
  const usedNames = new Set();
  const knownByName = new Map(known.map(record => [record.name, record]));

  for (const tag of tags) {
    const name = attr(tag, 'zh') || attr(tag, 'name');
    if (!name || usedNames.has(name)) continue;
    const release = releases.get(name);
    if (!release) throw new Error(`${name} is missing from the PRTS release timeline`);

    const rawRarity = Number(attr(tag, 'rarity'));
    const rarity = rawRarity + 1;
    if (!Number.isInteger(rawRarity) || rawRarity < 0 || rawRarity > 5) throw new Error(`${name} has invalid data-rarity`);
    if (rarity !== release.rarity) throw new Error(`${name} rarity mismatch: roster ${rarity}, timeline ${release.rarity}`);

    const rawId = attr(tag, 'id');
    const en = attr(tag, 'en') || name;
    const profession = attr(tag, 'profession');
    const subclass = attr(tag, 'subprofession');
    const logo = attr(tag, 'logo');
    const nation = attr(tag, 'nation');
    const faction = logo || nation;
    const group = attr(tag, 'group') || nation || faction;
    const operatorTags = attr(tag, 'tag').split(/[\s,，、]+/).map(value => value.trim()).filter(value => value && value !== '近战位' && value !== '远程位');

    for (const [field, value] of Object.entries({ id: rawId, profession, subclass, faction, group })) {
      if (!value) throw new Error(`${name} is missing PRTS ${field}`);
    }
    if (!operatorTags.length) throw new Error(`${name} has no PRTS tags`);

    records.push({
      id: knownByName.get(name)?.id || rawId || slug(en),
      name,
      en,
      rarity,
      class: profession,
      subclass,
      faction,
      group,
      year: release.year,
      tags: operatorTags,
      position: positionFor(attr(tag, 'position'), subclass, name),
      alterOf: null
    });
    usedNames.add(name);
  }

  if (records.length < 400 || records.length >= 500) throw new Error(`Unexpected PRTS roster size: ${records.length}`);
  return records;
}

function applyAlterRelationships(records) {
  const byName = new Map(records.map(record => [record.name, record]));
  for (const [alterName, originalName] of Object.entries(ALTER_NAMES)) {
    const alter = byName.get(alterName);
    const original = byName.get(originalName);
    if (!alter || !original) throw new Error(`Invalid alter relationship: ${alterName} -> ${originalName}`);
    alter.alterOf = original.id;
  }
}

function applyAlterFlags(records) {
  const alterFamilyIds = new Set();
  for (const record of records) {
    if (!record.alterOf) continue;
    alterFamilyIds.add(record.id);
    alterFamilyIds.add(record.alterOf);
  }
  for (const record of records) record.hasAlter = alterFamilyIds.has(record.id);
}

// options.force = true 时忽略本地 HTML 缓存，强制从 PRTS 重新抓取并刷新缓存。
export async function main(options = {}) {
  const force = Boolean(options.force);
  const [mainHtml, releaseHtml] = await Promise.all([
    readOrFetch(mainFile, MAIN_URL, force),
    readOrFetch(releaseFile, RELEASE_URL, force)
  ]);
  const releases = parseReleaseTimeline(releaseHtml);
  const result = parseMainRoster(mainHtml, releases);
  applyAlterRelationships(result);
  applyAlterFlags(result);

  const usedIds = new Set();
  for (const record of result) {
    if (usedIds.has(record.id)) throw new Error(`Duplicate operator id: ${record.id}`);
    usedIds.add(record.id);
  }

  result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
  const out = `// Generated from the PRTS Wiki main roster and release timeline.\nconst ARKNIGHTS_OPERATORS = ${JSON.stringify(result, null, 2)};\n\nif (typeof globalThis !== "undefined") globalThis.ARKNIGHTS_OPERATORS = ARKNIGHTS_OPERATORS;\nif (typeof module !== "undefined") module.exports = ARKNIGHTS_OPERATORS;\n`;
  const operatorFile = path.join(ROOT, 'data', 'arknights-operators.js');
  const temporary = `${operatorFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, out, 'utf8');
  try { await fs.rename(temporary, operatorFile); }
  catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    await fs.copyFile(temporary, operatorFile);
    await fs.unlink(temporary);
  }
  console.log(`[arknights] generated ${result.length} operators; ${Object.keys(ALTER_NAMES).length} alter relationships verified`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[arknights] ' + error.message);
    process.exitCode = 1;
  });
}