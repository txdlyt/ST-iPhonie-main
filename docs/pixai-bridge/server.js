import express from 'express';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ───────────── 配置：直接改这里，或用环境变量覆盖 ─────────────
const env = (key, fallback) => process.env[key] ?? fallback;
const json = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const CONFIG = {
  port: Number(env('PORT', 3188)),
  cdp: env('CDP', 'http://127.0.0.1:9222'),
  // 允许跨域的酒馆地址，逗号分隔
  origins: env('ALLOW_ORIGINS', 'https://tavo.thh.kdns.fr').split(',').map(s => s.trim()).filter(Boolean),
  // 填了就要求请求带 Authorization: Bearer <这个值>（插件里「NovelAI 密钥」填同一个值）；留空不校验
  token: env('BRIDGE_TOKEN', 'sunshine'),
  // PixAI 一次任务能出几张（网页上有的档位）
  counts: env('PIXAI_COUNTS', '1,4').split(',').map(Number).filter(n => n >= 1).sort((x, y) => x - y),
  // 没配置「切换张数」时，认为网页当前一次出几张
  pageCount: Number(env('PIXAI_PAGE_COUNT', 4)),
  // 切换网页张数的选择器：{"1": "选择器", "4": ["先点这个", "再点这个"]}；不配就不动网页上的设置
  qty: json(env('PIXAI_QTY', '{}'), {}),
  // 插件没带「一次几张」信息时（没打补丁的旧插件）：按同提示词出几张、多久内算同一批
  legacySize: Number(env('LEGACY_SIZE', 4)),
  legacyTtlMs: Number(env('LEGACY_TTL_SECONDS', 120)) * 1000,
  runTtlMs: Number(env('RUN_TTL_SECONDS', 600)) * 1000,
  // 请求等图超过这么多秒还没结果，就先把响应头发出去，之后每隔 KEEPALIVE_SECONDS 秒写一个空格字节保活。
  // 防止 nginx / Cloudflare / 酒馆转发这些中间环节因为「一直没有任何数据」把连接切断（酒馆会报 502/504/524，第一队列就断了）。
  keepAliveStartMs: Number(env('KEEPALIVE_START_SECONDS', 5)) * 1000,
  keepAliveMs: Number(env('KEEPALIVE_SECONDS', 10)) * 1000,
  // 找不到生图页时（比如 VPS 重启后浏览器是空白页）自动打开的地址
  pixaiUrl: env('PIXAI_URL', 'https://pixai.art/zh/generator/image'),
  // 打开生图页后自动选的模型（名字必须以此结尾）；设成空字符串则不自动选
  model: env('PIXAI_MODEL', 'MiaoMiao RealSkin 1.4'),
  // 出图前自动把网页的画面比例切到这个（默认竖图 9:16）；设成空字符串则不动网页上的比例
  ratio: env('PIXAI_RATIO', '9:16').trim(),
  // 换账号用的登录地址（打开后找不到密码框时，会再去点页面上的「登入/登录」按钮）
  loginUrl: env('PIXAI_LOGIN_URL', 'https://pixai.art/zh/login')
};

const app = express();
const allowed = origin => !!origin && CONFIG.origins.includes(origin);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(allowed(origin) ? 204 : 403);
  const publicPage = req.path === '/health' || (req.method === 'GET' && req.path === '/admin'); // /admin 只是个静态表单页，真正的操作接口都要密钥
  if (CONFIG.token && !publicPage && req.headers.authorization !== `Bearer ${CONFIG.token}`) {
    return res.status(401).json({ message: '密钥不对' });
  }
  next();
});
app.use(express.json({ limit: '20mb' }));

let browser;
let generating = false;
let genStart = 0, genEpoch = 0;
// 出图超过 8 分钟还没结束，就当它卡死了：管理页允许换账号 / 重试，不再被一直挡着
const isGenerating = () => generating && Date.now() - genStart < 8 * 60 * 1000;

async function connectBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.connectOverCDP(CONFIG.cdp);
  }
  return browser;
}

let opening = null;

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 页面是繁体，按文字匹配并兼容简繁。
// 流程：点「查看全部模型」→ 搜索框输入模型名 → 选中名字以该模型名结尾的卡片（如 ...1.4）→ 点「使用這個模型」
async function selectModel(page, model) {
  if (!model) return;
  console.log(`正在选择模型：${model}`);

  await page.getByRole('button', { name: /查看全部模型/ }).first().click({ timeout: 15000 });

  const dialog = page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: /市集/ }).last();
  await dialog.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  const scoped = (await dialog.count()) > 0;
  const root = scoped ? dialog : page;

  const search = scoped ? root.locator('input:visible').first() : page.locator('input:visible').last();
  await search.waitFor({ state: 'visible', timeout: 15000 });
  await search.fill(model);
  await search.press('Enter');

  const name = new RegExp(model.trim().split(/\s+/).map(escapeRegExp).join('\\s*') + '\\s*$', 'i');
  const card = root.getByText(name).last();
  try {
    await card.waitFor({ state: 'visible', timeout: 20000 });
  } catch {
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error(`搜索结果里没有名字以「${model}」结尾的模型`);
  }
  await card.click();
  await sleep(800);

  const use = root.getByRole('button', { name: /使用[這这][個个]模型/ }).first();
  await use.waitFor({ state: 'visible', timeout: 15000 });
  await use.click();
  await search.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  console.log(`已选择模型：${model}`);
}

// PixAI 打开生图页时常常先跳到首页（/zh）再跳回来，Playwright 会报「被另一次跳转打断」。这不是失败：等页面稳定后看一眼在哪，不对再来一次。
async function safeGoto(page, url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); return; }
    catch (error) {
      last = error;
      if (!/interrupted by another navigation|ERR_ABORTED|frame was detached/i.test(String(error.message))) throw error;
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await sleep(1500);
      if (page.url().includes(new URL(url).pathname.replace(/^\/[a-z]{2}(?=\/)/i, ''))) return; // 其实已经到了
    }
  }
  throw last;
}

// 找不到生图页就自己打开：优先复用空白页 / PixAI 其他页，否则新开标签。登录状态来自浏览器持久化数据，不用重新登录。
async function openGeneratorPage() {
  const ctx = (await connectBrowser()).contexts()[0];
  const pages = ctx.pages();
  const page = pages.find(p => /^(about:blank|chrome:\/\/newtab)/.test(p.url()))
    ?? pages.find(p => p.url().includes('pixai.art'))
    ?? await ctx.newPage();

  console.log(`未找到生图页，正在打开：${CONFIG.pixaiUrl}`);
  await safeGoto(page, CONFIG.pixaiUrl);

  const ready = await page
    .locator('div[contenteditable="true"].tiptap.ProseMirror')
    .waitFor({ state: 'visible', timeout: 30000 })
    .then(() => true, () => false);

  if (!page.url().includes('/generator/image')) {
    const error = new Error(`打开生图页后被跳转到 ${page.url()}，登录可能已失效，请人工重新登录一次`);
    error.login = true;
    throw error;
  }
  if (!ready) console.log('生图页已打开，但提示词输入框暂未出现');

  await dismissDailyReward(page);
  // 只打开生图页：不再自动选模型、比例（模型、LoRA、比例由你在网页上定，或由插件出图时指定）
  watchApiHeaders(page);
  return page;
}

async function getPixAIPage() {
  if (opening) return await opening;
  const ctx = (await connectBrowser()).contexts()[0];
  const existing = ctx.pages().find(p => p.url().includes('/generator/image'));
  if (existing) { watchApiHeaders(existing); return existing; }
  // 并发调用只开一次页面
  return await (opening ??= openGeneratorPage().finally(() => { opening = null; }));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// base：响应前面已经先发出去的保活字节数。ZIP 里所有偏移量要把它算进去（客户端从整个响应开头算偏移）。
function makeZip(files, base = 0) {
  const local = [], central = [];
  let offset = base;

  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = file.data;
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, directory, end]);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ==BATCHER-START==
/**
 * 把「插件一张一张发的请求」对应到「PixAI 一次任务出的几张图」。
 *
 * 插件（打了补丁的）每个请求都带 bridge_batch = {run, index, size}：同一次出图的 run 相同，index 是第几张，
 * size 是一共几张。于是：
 *   - 出 1 张 → 只开 1 张的任务；出 4 张 → 开 1 个 4 张的任务，4 个请求各领 1 张；
 *   - 出 6 张 → 4 + 4（后一个任务只用 2 张），出 2 张 → 用能出 ≥2 张的最小档；
 *   - 同一个请求重试（同 run、同 index）拿到的是同一张图，不会多领；
 *   - 不同 run 即使提示词一样也不会串图；
 *   - 某个任务失败不会占用名额，重试会重新开任务。
 * 没带 bridge_batch 的请求走旧逻辑：按提示词归批，每批 legacySize 张，超过 legacyTtlMs 没人领就作废。
 *
 * generate(prompt, count) → {taskId, files:[{name, data}]}，由外面真正去 PixAI 出图。
 */
class Batcher {
  constructor({ generate, counts = [1, 4], runTtlMs = 600000, legacySize = 4, legacyTtlMs = 120000, now = Date.now }) {
    Object.assign(this, { generate, runTtlMs, legacySize, legacyTtlMs, now });
    this.counts = [...counts].sort((x, y) => x - y);
    this.runs = new Map();
  }

  countFor(remaining) {
    return this.counts.find(c => c >= remaining) ?? this.counts.at(-1);
  }

  prune() {
    const t = this.now();
    for (const [key, run] of this.runs) {
      if (t - run.used > (run.legacy ? this.legacyTtlMs : this.runTtlMs)) this.runs.delete(key);
    }
    while (this.runs.size > 16) this.runs.delete(this.runs.keys().next().value);
  }

  /** hint: {run, index, size} 或 null。返回 {file, index, size, taskId}。 */
  async take(prompt, hint, spec = null) {
    this.prune();
    const per = this.counts.at(-1);
    let key, run, index;

    if (hint) {
      key = 'run:' + hint.run;
      run = this.runs.get(key);
      // hint.recover: the plugin lost the answer and only wants this picture again: never draw one for it.
      // 取回（recover）只认批次号：它是随机生成的，不会撞；提示词在重试时可能被酒馆重新整理过，不能因为文字对不上就说图没了
      if (hint.recover && run && run.prompt !== prompt) { console.warn(`取回 ${hint.run} 第 ${hint.index + 1} 张：提示词和当时不一样，按批次号取回`); prompt = run.prompt; }
      if (!run || run.prompt !== prompt) {
        if (hint.recover) { console.warn(`取回 ${hint.run} 第 ${hint.index + 1} 张失败：反代里没有这个批次（超过 10 分钟、重启过，或换了账号）`); throw Object.assign(new Error('这张图已不在反代里'), { code: 'EXPIRED' }); }
        run = { legacy: false, prompt, size: hint.size, groups: new Map(), used: 0, next: 0, spec };
      }
      run.size = hint.size;
      index = hint.index;
    } else {
      key = 'legacy:' + prompt;
      run = this.runs.get(key) ?? { legacy: true, prompt, size: this.legacySize, groups: new Map(), used: 0, next: 0, spec };
      index = run.next;
    }
    this.runs.delete(key);
    this.runs.set(key, run);
    run.used = this.now();

    const group = Math.floor(index / per), slot = index % per;
    const want = this.countFor(Math.min(per, Math.max(1, run.size - group * per)));
    let entry = run.groups.get(group);
    if (hint?.recover && (!entry || (entry.result && slot >= entry.result.files.length))) {
      console.warn(`取回 ${hint.run} 第 ${hint.index + 1} 张失败：这个批次${!entry ? '这一组没有出成功（出图时报过错，或还没出）' : '只出了 ' + entry.result.files.length + ' 张'}`);
      throw Object.assign(new Error('这张图已不在反代里'), { code: 'EXPIRED' });
    }
    if (!entry || (entry.result && slot >= entry.result.files.length)) {
      entry = { result: null, promise: null };
      run.groups.set(group, entry);
      entry.promise = this.generate(prompt, want, run.spec ?? null).then(
        result => (entry.result = result),
        error => { if (run.groups.get(group) === entry) run.groups.delete(group); throw error; }
      );
    }
    const result = await entry.promise;
    const file = result.files[slot];
    if (!file) throw new Error(`PixAI 这一批只出了 ${result.files.length} 张，没有第 ${slot + 1} 张`);

    if (run.legacy) {
      run.next = index + 1;
      if (run.next >= run.size) this.runs.delete(key);
    }
    return { file, index, size: run.size, taskId: result.taskId };
  }
}
// ==BATCHER-END==

const THUMB = 'button[data-testid="mobile-task-card-thumb"][data-media-id]';
const CARD = 'section[data-testid="mobile-task-card"][data-task-id]';
const ALL_DOWNLOAD = 'button[aria-label="全部下載"], button[aria-label="全部下载"]';
const ANY_DOWNLOAD = 'button[aria-label*="下载"], button[aria-label*="下載"]';

/**
 * PixAI 任务卡可能先挂出缩略图占位，再继续生成/替换图片。
 * 不能只凭缩略图数量达到 expected 就立刻下载；这里要求缩略图集合及其图片源连续稳定一段时间，
 * 且已存在的 img 均完成加载。该检查是 DOM 可观测范围内的防抖，不伪造 PixAI 内部任务状态。
 */
async function waitForTaskReady(page, card, expected, { stableMs = 8000, timeoutMs = 300000 } = {}) {
  const started = Date.now();
  let signature = '';
  let stableSince = 0;

  while (Date.now() - started < timeoutMs) {
    const state = await card.evaluate((root, selector) => {
      const thumbs = Array.from(root.querySelectorAll(selector));
      const ids = thumbs.map(el => el.getAttribute('data-media-id')).filter(Boolean);
      const images = thumbs.flatMap(el => Array.from(el.querySelectorAll('img')));
      const imagesReady = images.every(img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
      const imageState = images.map(img => `${img.currentSrc || img.src}:${img.naturalWidth}x${img.naturalHeight}`).join('|');
      const downloadButtons = Array.from(root.querySelectorAll('button[aria-label*="下载"],button[aria-label*="下載"]'));
      const enabledDownload = downloadButtons.some(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true');
      return {
        count: thumbs.length,
        ids,
        imagesReady,
        signature: `${ids.join(',')}::${imageState}::${downloadButtons.length}:${enabledDownload}`,
        enabledDownload
      };
    }, THUMB);

    const enough = state.count >= expected && state.ids.length >= expected && new Set(state.ids).size >= expected;
    const ready = enough && state.imagesReady && state.enabledDownload;
    if (ready && state.signature === signature) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) {
        console.log(`PixAI 任务卡稳定：${state.ids.length} 张缩略图，连续 ${stableMs}ms 未变化`);
        return state;
      }
    } else {
      signature = state.signature;
      stableSince = ready ? Date.now() : 0;
    }
    await sleep(500);
  }

  throw new Error(`PixAI 任务未达到可下载稳定状态（等待 ${Math.round(timeoutMs / 1000)} 秒）；没有提前把图片交给酒馆`);
}

async function collectDownloads(page, card, expected) {
  const downloads = [];
  const listener = download => downloads.push(download);
  page.on('download', listener);
  let tempDir;

  try {
    // 4 张时有「全部下载」；只出 1 张时这个按钮可能没有，退回找任意下载按钮
    let button = card.locator(ALL_DOWNLOAD).first();
    const hasAll = await button.waitFor({ state: 'visible', timeout: expected > 1 ? 30000 : 5000 }).then(() => true, () => false);
    if (!hasAll) {
      button = card.locator(ANY_DOWNLOAD).first();
      await button.waitFor({ state: 'visible', timeout: 15000 });
    }
    await button.click();

    const deadline = Date.now() + 120000;
    let previousCount = 0;
    let lastChange = Date.now();

    while (Date.now() < deadline) {
      if (downloads.length !== previousCount) {
        previousCount = downloads.length;
        lastChange = Date.now();
      }
      if (downloads.length >= expected) break;
      if (downloads.length > 0 && Date.now() - lastChange > 15000) break;
      await sleep(300);
    }

    if (downloads.length < expected) {
      throw new Error(`PixAI 下载数量异常：收到 ${downloads.length}/${expected} 张图片`);
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixai-'));
    const files = [];
    for (let i = 0; i < downloads.length; i++) {
      const download = downloads[i];
      const failure = await download.failure();
      if (failure) throw new Error(`第 ${i + 1} 张图片下载失败：${failure}`);

      const ext = path.extname(download.suggestedFilename()).toLowerCase() || '.png';
      const filename = path.join(tempDir, `image_${i}${ext}`);
      await download.saveAs(filename);
      const data = await fs.readFile(filename);
      if (data.length < 100) throw new Error(`第 ${i + 1} 张图片文件无效`);
      files.push({ name: `image_${i}${ext}`, data });
    }
    return files;
  } finally {
    page.off('download', listener);
    if (tempDir) fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 网页上「一次出几张」是一组 role=radio 的按钮：「單張」「多張 (x4)」。判断哪个被选中，和 /ai/status 用同一套办法。
// 网页现在写「1 張」「4 張」；旧版写「單張」「多張 (x4)」，两种都认。
const COUNT_LABEL = n => new RegExp(`(^|\\D)${n}\\s*[張张]|x\\s*${n}(?!\\d)${n === 1 ? '|單張|单张' : ''}`, 'i');

async function readPageCount(page) {
  return page.evaluate(() => {
    const visible = el => !!(el.offsetWidth || el.offsetHeight);
    const text = el => (el.innerText || '').replace(/\s+/g, ' ').trim();
    const radios = Array.from(document.querySelectorAll('[role="radio"]')).filter(visible);
    const isOn = el => {
      const a = n => el.getAttribute(n);
      return a('aria-checked') === 'true' || a('aria-pressed') === 'true' || a('aria-selected') === 'true' ||
        a('data-selected') === 'true' || a('data-pressed') === 'true' || ['on', 'checked', 'active', 'selected'].includes(a('data-state')) ||
        /(^|\s)ring-neutral-700(\s|$)/.test(String(el.className || ''));
    };
    let hit = radios.find(isOn);
    if (!hit && radios.length > 1) {
      const sig = el => { const st = getComputedStyle(el); return [st.backgroundColor, st.borderTopColor, st.boxShadow, st.color, st.fontWeight].join('|'); };
      const seen = new Map();
      radios.forEach(el => seen.set(sig(el), (seen.get(sig(el)) || 0) + 1));
      const odd = radios.filter(el => seen.get(sig(el)) === 1);
      hit = odd.length === 1 ? odd[0] : null;
    }
    const label = hit ? text(hit) : null;
    if (!label) return null;
    const m = /(\d+)\s*[張张]/.exec(label) || /x\s*(\d+)/i.exec(label);
    return m ? Number(m[1]) : /單張|单张/.test(label) ? 1 : null;
  });
}

/** 把网页上的「一次出几张」切到 count，并确认真的切过去了。配了 PIXAI_QTY 就按选择器点，否则直接点网页的单选按钮。 */
async function setQuantity(page, count) {
  const steps = [].concat(CONFIG.qty[String(count)] || []);
  if (steps.length) {
    for (const selector of steps) {
      const target = page.locator(selector).first();
      await target.waitFor({ state: 'visible', timeout: 10000 });
      await target.click();
      await sleep(300);
    }
    return true;
  }
  if (!(await openSettingsTab(page))) { console.warn('没找到设定页，没有切换张数'); return false; } // 刚切过模型时页面可能停在别的标签页
  if ((await readPageCount(page)) === count) return true;
  let target = page.locator('[role="radio"]').filter({ hasText: COUNT_LABEL(count) }).first();
  if (!(await target.count())) {
    // 单选按钮里没有：改按文字找（带「單張」「多張」字样的可见元素），并把页面上实际有的打印出来，方便对照
    const seen = await page.evaluate(() => Array.from(document.querySelectorAll('body *')).filter(el => (el.offsetWidth || el.offsetHeight) && /單張|单张|多張|多张|\d\s*[張张]|x\s*4/i.test((el.innerText || '').trim()) && (el.innerText || '').trim().length < 24)
      .slice(0, 12).map(el => `${el.tagName.toLowerCase()}[role=${el.getAttribute('role') || ''}]「${(el.innerText || '').trim().replace(/\s+/g, ' ')}」`));
    console.warn(`网页上没找到「一次出 ${count} 张」的单选按钮；页面上带张数字样的元素：${seen.join('  ') || '无'}`);
    target = page.locator('button, label, [role="radio"], [role="button"], div').filter({ hasText: COUNT_LABEL(count) }).filter({ hasNotText: /\n/ }).last();
    if (!(await target.count())) { console.warn(`按文字也没找到「一次出 ${count} 张」，没有切换`); return false; }
  }
  await target.click();
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    if ((await readPageCount(page)) === count) return true;
  }
  console.warn(`点了「一次出 ${count} 张」，但网页上没有变过去`);
  return false;
}

/**
 * 页面一刷新/重新打开就会弹「每日領取」签到框（里面有 Cloudflare「驗證您是人類」勾选 + 「領取今日獎勵」按钮），挡住后面所有点击。
 * 这里自动处理：勾验证 → 等「領取今日獎勵」可点 → 点它 → 关掉。没弹出就立刻返回；处理失败只警告，不抛错。
 */
// 最近一次处理每日领取弹窗时，有没有看到「獎勵已領取！明天見！」（领取成功的最终状态）
let dailyClaimed = false;
async function dismissDailyReward(page) {
  dailyClaimed = false;
  try {
    const title = page.getByText(/^\s*每日(領取|领取)\s*$/).first();
    if (!(await title.isVisible().catch(() => false))) return false;
    console.log('检测到「每日領取」弹窗，自动处理…');

    const claim = page.getByRole('button', { name: /^(?!.*(已領取|已领取)).*(領取|领取)(今日獎勵|今日奖励)?\s*$/ }).first(); // 没勾验证时按钮叫「領取」，勾上后才变「領取今日獎勵」
    const done = page.getByRole('button', { name: /獎勵已領取|奖励已领取|明天見|明天见/ }).first();

    if (await claim.isVisible().catch(() => false)) {
      // 状态 1：还没验证，按钮灰着。状态 2：验证显示「成功!」，按钮变紫可点。没过就再点一次勾选框，最多 3 轮。
      const frame = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
      for (let round = 1; round <= 3 && !(await claim.isEnabled().catch(() => false)); round++) {
        // 验证框的位置，几种办法依次找：① 页面里的 iframe 元素 ② Playwright 的 frame 列表（iframe 藏在 shadow DOM 里时 ① 找不到）③ 「驗證您是人類」那行字，勾选框就在它左边
        let box = null, how = '';
        if (await frame.count()) {
          await frame.scrollIntoViewIfNeeded().catch(() => {});
          box = await frame.boundingBox(); how = 'iframe';
        }
        if (!box) {
          const f = page.frames().find(fr => /challenges\.cloudflare\.com/.test(fr.url()));
          const el = f && await f.frameElement().catch(() => null);
          if (el) { await el.scrollIntoViewIfNeeded().catch(() => {}); box = await el.boundingBox(); how = 'frame列表'; }
        }
        if (!box) {
          // 真实页面里验证框是 #cf-turnstile 里的跨域 frame（iframe 元素在 shadow DOM 里，选不到）；容器也行
          const holder = page.locator('#cf-turnstile').first();
          if (await holder.count()) { await holder.scrollIntoViewIfNeeded().catch(() => {}); box = await holder.boundingBox(); how = '#cf-turnstile'; }
        }
        if (box) {
          await page.mouse.move(box.x + 14, box.y + box.height / 2, { steps: 6 });
          await sleep(200 + Math.floor(Math.random() * 300));
          await page.mouse.click(box.x + 28, box.y + box.height / 2); // 真实鼠标点验证框里左边的勾选框
          console.log(`签到验证：点了勾选框（${how}，第 ${round} 轮）`);
        } else {
          const label = page.getByText(/驗證您是人類|验证您是人类|Verify you are human/).first();
          const lb = await label.isVisible().catch(() => false) ? await label.boundingBox() : null;
          if (lb) {
            await page.mouse.move(lb.x - 20, lb.y + lb.height / 2, { steps: 6 });
            await sleep(200 + Math.floor(Math.random() * 300));
            await page.mouse.click(Math.max(2, lb.x - 28), lb.y + lb.height / 2);
            console.log(`签到验证：按文字位置点了勾选框（第 ${round} 轮）`);
          } else {
            console.warn('签到弹窗里找不到验证框（iframe、frame 列表、文字都没有）');
            break;
          }
        }
        for (let i = 0; i < 30 && !(await claim.isEnabled().catch(() => false)); i++) await sleep(500);
        if (!(await claim.isEnabled().catch(() => false))) console.warn(`签到验证第 ${round}/3 轮没通过`);
      }
      if (await claim.isEnabled().catch(() => false)) {
        await claim.click({ timeout: 5000 });
        await done.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      } else {
        console.warn('签到验证没通过，「領取今日獎勵」一直点不了；用 6080 端口的浏览器手动点一次');
      }
    }
    // 最终状态：按钮变成「獎勵已領取！明天見！」，弹窗里的「今日獎勵」也变成「已領取」。领完弹窗不会自己关：和手动一样，点弹窗外的空白处关掉（点不掉再按 Esc）
    dailyClaimed = await done.isVisible().catch(() => false);
    if (await title.isVisible().catch(() => false)) {
      const dialog = page.locator('section[role="dialog"]').filter({ hasText: /每日(領取|领取)/ }).first();
      const rect = await dialog.boundingBox().catch(() => null);
      const vp = page.viewportSize() || { width: 1280, height: 800 };
      const blank = rect
        ? [rect.x > 40 ? rect.x / 2 : Math.min(vp.width - 10, rect.x + rect.width + 20), rect.y + rect.height / 2]
        : [10, vp.height / 2];
      await page.mouse.click(blank[0], blank[1]).catch(() => {});
      await sleep(600);
    }
    if (await title.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(500);
    }
    const closed = await title.waitFor({ state: 'hidden', timeout: 5000 }).then(() => true, () => false);
    console.log(closed ? '签到弹窗已处理' : '签到弹窗没能关掉，请人工处理');
    return closed;
  } catch (error) {
    console.warn('处理签到弹窗失败：', error.message);
    return false;
  }
}

/** 把网页的画面比例切到 ratio（如 9:16）：选中的比例按钮带 ring-neutral-700（和 /ai/status 同一套判断）。已经是它就不点。 */
async function setRatio(page, ratio) {
  if (!ratio) return true;
  const state = () => page.evaluate(want => {
    const visible = el => !!(el.offsetWidth || el.offsetHeight);
    const text = el => (el.innerText || '').replace(/\s+/g, ' ').trim();
    const buttons = Array.from(document.querySelectorAll('button, [role="radio"]')).filter(visible).filter(el => /^\d+:\d+$/.test(text(el)));
    const on = el => {
      const a = n => el.getAttribute(n);
      return a('aria-checked') === 'true' || a('aria-pressed') === 'true' || a('aria-selected') === 'true' || a('data-selected') === 'true' ||
        ['on', 'checked', 'active', 'selected'].includes(a('data-state')) || /(^|\s)ring-neutral-700(\s|$)/.test(String(el.className || ''));
    };
    const target = buttons.find(el => text(el) === want);
    return { found: !!target, selected: !!target && on(target), others: buttons.map(text) };
  }, ratio);
  let now = await state();
  if (!now.found) {
    // 比例按钮在右侧面板的「設定」标签页里；选完模型后可能停在「模型/風格」页，先切到「設定」再找
    const tab = page.getByRole('tab', { name: /^\s*(設定|设置|設置)\s*$/ }).first();
    const tabLike = (await tab.count()) ? tab : page.locator('button, [role="tab"], div, span').filter({ hasText: /^\s*(設定|设置|設置)\s*$/ }).last();
    if (await tabLike.count()) { await tabLike.click({ timeout: 5000 }).catch(() => {}); await sleep(600); now = await state(); }
  }
  if (!now.found) { console.warn(`网页上没找到比例按钮「${ratio}」（现有：${now.others.join(' ') || '无'}），没有切换`); return false; }
  if (now.selected) return true;
  const target = page.locator('button, [role="radio"]').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(ratio)}\\s*$`) }).first();
  await target.click({ timeout: 10000 });
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    now = await state();
    if (now.selected) { console.log(`已把画面比例切到 ${ratio}`); return true; }
  }
  console.warn(`点了比例「${ratio}」，但网页上没有变过去`);
  return false;
}

// 酒馆插件选过比例/尺寸/横竖之后，就以它选的为准，不再按 PIXAI_RATIO 每次切回去（反代重启后清零，回到 PIXAI_RATIO 默认）。
let pagePicked = false;

/** 切到「設定」标签页（比例/尺寸/张数按钮都在这一页）。已经在就不动。 */
async function openSettingsTab(page) {
  const there = () => page.evaluate(() => Array.from(document.querySelectorAll('button')).some(el => (el.offsetWidth || el.offsetHeight) && /^\d+:\d+$/.test((el.innerText || '').trim())));
  if (await there()) return true;
  const tab = page.getByRole('tab', { name: /^\s*(設定|设置|設置)\s*$/ }).first();
  if (await tab.count()) { await tab.click({ timeout: 5000 }).catch(() => {}); await sleep(600); }
  return await there();
}

/** 选尺寸档位：label 是档位字母（M / L …），点页面上以它开头的尺寸按钮。被锁（disabled）的不点。 */
async function setSize(page, label) {
  const want = String(label || '').trim().toUpperCase();
  if (!want) return false;
  if (!(await openSettingsTab(page))) { console.warn('没找到设定页，没有切换尺寸'); return false; }
  const state = () => page.evaluate(want => {
    const visible = el => !!(el.offsetWidth || el.offsetHeight);
    const text = el => (el.innerText || '').replace(/\s+/g, ' ').trim();
    const buttons = Array.from(document.querySelectorAll('button, [role="radio"]')).filter(visible).filter(el => /^[A-Z]{1,3}\s*\d+\s*[×x]\s*\d+$/i.test(text(el)));
    const on = el => /(^|\s)ring-neutral-700(\s|$)/.test(String(el.className || '')) || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
    const target = buttons.find(el => text(el).toUpperCase().startsWith(want));
    const locked = el => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled');
    return { found: !!target, selected: !!target && on(target), locked: !!target && locked(target), others: buttons.map(text) };
  }, want);
  let now = await state();
  if (!now.found) { console.warn(`网页上没找到尺寸「${want}」（现有：${now.others.join(' ') || '无'}），没有切换`); return false; }
  if (now.selected) return true;
  if (now.locked) { console.warn(`尺寸「${want}」被锁住了（可能要会员），没有切换`); return false; }
  const target = page.locator('button, [role="radio"]').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(want)}\\s*\\d+\\s*[×x]\\s*\\d+\\s*$`, 'i') }).first();
  await target.click({ timeout: 10000 });
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    now = await state();
    if (now.selected) { console.log(`已把尺寸切到 ${want}`); return true; }
  }
  console.warn(`点了尺寸「${want}」，但网页上没有变过去`);
  return false;
}

/** 点网页自带的「切換橫豎」，横竖互换。以比例按钮或尺寸按钮的文字有没有变来判断点上了。 */
async function swapOrientation(page) {
  if (!(await openSettingsTab(page))) { console.warn('没找到设定页，没有横竖切换'); return false; }
  const sig = () => page.evaluate(() => {
    const visible = el => !!(el.offsetWidth || el.offsetHeight);
    return Array.from(document.querySelectorAll('button')).filter(visible).map(el => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(t => /^\d+:\d+$/.test(t) || /^[A-Z]{1,3}\s*\d+\s*[×x]\s*\d+$/i.test(t)).join('|');
  });
  const before = await sig();
  const button = page.locator('button[aria-label="切換橫豎"]').first();
  if (!(await button.count())) { console.warn('网页上没找到「切換橫豎」按钮'); return false; }
  await button.click({ timeout: 10000 });
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    if ((await sig()) !== before) { console.log('已切換橫豎'); return true; }
  }
  console.warn('点了「切換橫豎」，但网页上没有变化');
  return false;
}

// ───────────── 模型预设：酒馆插件里选「用哪个模型」，反代在网页上把模型、LoRA、Recipe 一起切好 ─────────────
// 规则：预设里写了 LoRA / Recipe 就确保它们选上；没写的（空数组）就把网页上已选的全部移除。
// 可以用环境变量 PIXAI_MODELS 覆盖，格式：[{"id":"x","name":"显示名","key":"卡片上的名字","exact":true,"search":"搜索词","loras":["LoRA 名"],"recipes":["Recipe 名"]}]
const MODEL_PRESETS = json(env('PIXAI_MODELS', ''), null) || [
  { id: 'miaomiao', name: 'MiaoMiao RealSkin 1.4', key: 'MiaoMiao RealSkin', exact: false, search: 'MiaoMiao RealSkin 1.4', loras: [], recipes: [] },
  { id: 'tsubaki2', name: 'Tsubaki.2', key: 'Tsubaki.2', exact: true, search: 'Tsubaki.2', loras: ['リアル、コスプレ、実写'], recipes: ['Dash of realism'] }
];
const normName = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
const modelMatches = (preset, name) => !!name && (preset.exact ? normName(name) === normName(preset.key) : normName(name).includes(normName(preset.key)));

/** 读网页上现在选着的模型、Recipe、LoRA 的名字。找不到右侧面板时返回 null。 */
async function readModelInfo(page) {
  return await page.evaluate(() => {
    const text = el => (el?.innerText || '').replace(/\s+/g, ' ').trim();
    const card = document.querySelector('section[data-section="model"] [data-testid="selected-entity-card"]');
    const recipeBlock = Array.from(document.querySelectorAll('h3')).find(h => /^Recipe/.test(text(h)))?.closest('section');
    const loraBlock = document.querySelector('section[data-share-guide="selected-loras"]');
    if (!card && !recipeBlock && !loraBlock) return null;
    return {
      name: card ? text(card.querySelector('span.font-semibold') || card.querySelector('a span') || card.querySelector('a')) || null : null,
      recipes: recipeBlock ? Array.from(recipeBlock.querySelectorAll('ul li strong')).map(text).filter(Boolean) : [],
      loras: loraBlock ? Array.from(loraBlock.querySelectorAll('a[class*="truncate"]')).map(text).filter(Boolean) : []
    };
  });
}

/** 右侧「模型」面板：不在眼前（窄屏下标签页切走了）就切回「模型」标签。 */
async function ensureModelPanel(page) {
  const there = async () => (await page.locator('section[data-section="model"]').count()) > 0 && (await page.locator('section[data-section="model"]').first().isVisible().catch(() => false));
  if (await there()) return true;
  const tab = page.getByRole('tab', { name: /^\s*模型\s*$/ }).first();
  if (await tab.count()) { await tab.click({ timeout: 5000 }).catch(() => {}); await sleep(700); }
  return await there();
}

async function waitFor(check, timeoutMs, stepMs = 300) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return true; await sleep(stepMs); }
  return false;
}

/** 选模型：先点右侧「快速選擇」里名字完全一样的卡片（点它就是选中，不会跳页）；没有这张卡就走「查看全部模型」搜索。 */
async function chooseModel(page, preset) {
  const current = async () => modelMatches(preset, (await readModelInfo(page))?.name);
  if (await current()) return;
  await ensureModelPanel(page);
  const card = page.locator(`section[aria-label="快速選擇"] a[aria-label=${JSON.stringify(preset.name)}]`).first();
  if (await card.count()) {
    await card.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await card.click({ timeout: 8000 }).catch(error => console.warn('点快速選擇里的卡片失败：', error.message));
    if (await waitFor(current, 8000)) { console.log(`已选择模型：${preset.name}（快速選擇）`); return; }
    console.warn(`点了快速選擇里的「${preset.name}」，但模型没变过去，改用「查看全部模型」`);
  }
  await selectModel(page, preset.search || preset.name);
  if (!(await waitFor(current, 10000))) throw new Error(`选了模型「${preset.name}」，但网页上的模型没变过去`);
}

const openDialog = async (page, opener) => {
  await opener.click({ timeout: 10000 });
  const dialog = page.locator('[role="dialog"]:visible').last();
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  return dialog;
};

/** 弹窗里点确认按钮；按钮灰着（选择没变化）就改点「關閉」。 */
async function confirmDialog(page, dialog, confirmName) {
  const ok = dialog.getByRole('button', { name: confirmName }).first();
  const enabled = await waitFor(async () => (await ok.count()) > 0 && await ok.isEnabled().catch(() => false), 6000, 250);
  if (enabled) await ok.click({ timeout: 8000 });
  else await dialog.getByRole('button', { name: /^(關閉|关闭)$/ }).first().click({ timeout: 8000 }).catch(() => page.keyboard.press('Escape'));
  await dialog.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await sleep(500);
}

const recipeBlock = page => page.locator('section').filter({ has: page.locator('h3', { hasText: /^Recipe/ }) }).last();

async function removeRecipes(page) {
  for (let i = 0; i < 12; i++) {
    const button = recipeBlock(page).locator('ul li button[aria-label^="移除"]').first();
    if (!(await button.count())) return;
    await button.click({ timeout: 8000 });
    await sleep(500);
  }
}

async function ensureRecipe(page, name) {
  const has = async () => ((await readModelInfo(page))?.recipes || []).some(item => normName(item) === normName(name));
  if (await has()) return;
  const dialog = await openDialog(page, recipeBlock(page).getByRole('button', { name: /查看全部\s*Recipe/ }).first());
  const search = dialog.locator('input[type="search"]').first();
  await search.waitFor({ state: 'visible', timeout: 10000 });
  await search.fill(name);
  await search.press('Enter');
  const label = dialog.locator('label').filter({ has: page.locator(`input[aria-label=${JSON.stringify(name)}]`) }).first();
  try { await label.waitFor({ state: 'visible', timeout: 20000 }); }
  catch { await dialog.getByRole('button', { name: /^(關閉|关闭)$/ }).first().click().catch(() => {}); throw new Error(`Recipe 搜索结果里没有「${name}」`); }
  if (!(await label.locator('input[type="checkbox"]').isChecked())) await label.click({ timeout: 8000 });
  await confirmDialog(page, dialog, /^(確認|确认)$/);
  if (!(await waitFor(has, 6000))) throw new Error(`选了 Recipe「${name}」，但网页上没有出现`);
  console.log(`已选择 Recipe：${name}`);
}

const loraBlock = page => page.locator('section[data-share-guide="selected-loras"]');

async function removeLoras(page) {
  for (let i = 0; i < 20; i++) {
    const button = loraBlock(page).locator('button[aria-label="移除"]').first();
    if (!(await button.count())) break;
    await button.click({ timeout: 8000 });
    await sleep(500);
  }
  // 输入框里的 LoRA 触发词芯片，LoRA 没了它还在的话也去掉
  for (let i = 0; i < 20; i++) {
    const chip = page.locator('div[contenteditable="true"].tiptap.ProseMirror button[aria-label="Remove LoRA trigger words"]').first();
    if (!(await chip.count())) break;
    await chip.click({ timeout: 8000 }).catch(() => {});
    await sleep(400);
  }
}

async function ensureLora(page, name) {
  const has = async () => ((await readModelInfo(page))?.loras || []).some(item => normName(item) === normName(name));
  if (await has()) return;
  const open = page.locator('section').filter({ has: page.locator('h3', { hasText: /^LoRA/ }) }).last().getByRole('button', { name: /查看全部\s*LoRA/ }).first();
  const dialog = await openDialog(page, open);
  const search = dialog.locator('input[type="search"]').first();
  await search.waitFor({ state: 'visible', timeout: 10000 });
  await search.fill(name);
  await search.press('Enter');
  const label = dialog.locator(`label[title=${JSON.stringify(name)}]`).first();
  try { await label.waitFor({ state: 'visible', timeout: 20000 }); }
  catch { await dialog.getByRole('button', { name: /^(關閉|关闭)$/ }).first().click().catch(() => {}); throw new Error(`LoRA 搜索结果里没有「${name}」`); }
  // 卡片里的名字和图片是个链接（点了会在新标签页打开），所以只点勾选框本身
  const box = label.locator('input[type="checkbox"]').first();
  if (!(await box.isChecked())) await box.evaluate(el => el.click());
  await confirmDialog(page, dialog, /^(確認選擇|确认选择)$/);
  if (!(await waitFor(has, 6000))) throw new Error(`选了 LoRA「${name}」，但网页上没有出现`);
  console.log(`已选择 LoRA：${name}`);
}

// ───────────── 判定 + 重试 ─────────────
// 每一步：先清掉挡路的弹窗（积分不足、签到失败这类，点空白处就关）→ 做 → 读回网页核对；对了就过，不对等一会儿再来，最多 PIXAI_RETRIES 次。
const RETRY = { tries: Math.max(1, Number(env('PIXAI_RETRIES', 3)) || 3), gap: Math.max(0, Number(env('PIXAI_RETRY_GAP', 2000)) || 2000) };

/**
 * 关掉页面上挡着的弹窗：点弹窗外的空白处（和手动一样），不行再按 Esc，并确认它真的没了。
 * keepDaily：「每日領取」交给 dismissDailyReward 去领，这里不动它。注意别在 Recipe / LoRA 选择弹窗开着的时候调用。
 */
async function dismissPopups(page, { keepDaily = true } = {}) {
  let closed = 0;
  for (let i = 0; i < 4; i++) {
    // 只认盖在整页上的弹窗（外层是 fixed 遮罩）；页面自带的非模态提示不碰，免得白点一下空白处
    const dialog = page.locator('.fixed [role="dialog"]:visible, .fixed [role="alertdialog"]:visible').last();
    if (!(await dialog.count())) break;
    const text = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (keepDaily && /每日(領取|领取)/.test(text)) break;
    const gone = () => dialog.waitFor({ state: 'hidden', timeout: 1500 }).then(() => true, () => false);
    await page.mouse.click(5, 5).catch(() => {});
    let ok = await gone();
    if (!ok) { await page.keyboard.press('Escape').catch(() => {}); ok = await gone(); }
    if (!ok) { console.warn(`弹窗没能关掉：${text.slice(0, 80)}`); break; }
    closed++;
    console.log(`已关掉弹窗：${text.slice(0, 80)}`);
  }
  return closed;
}

/** task 返回 false 或抛错都算没成功；每次重来前先清弹窗（含每日领取），隔 RETRY.gap 毫秒。 */
async function withRetry(page, label, task, { tries = RETRY.tries, gap = RETRY.gap } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    await dismissDailyReward(page).catch(() => {});
    await dismissPopups(page).catch(() => {});
    try {
      if ((await task()) !== false) return true;
      last = new Error('网页上没有变过去');
    } catch (error) { last = error; }
    console.warn(`${label} 第 ${attempt}/${tries} 次没成功：${last.message}`);
    if (attempt < tries) await sleep(gap);
  }
  throw last;
}

/** 网页上的模型、LoRA、Recipe 是不是正好是预设要的（没写的就必须一个都没有）。 */
async function modelIsRight(page, id) {
  const preset = MODEL_PRESETS.find(item => item.id === id);
  const info = preset && await readModelInfo(page).catch(() => null);
  if (!info || !modelMatches(preset, info.name)) return false;
  const same = (want, got) => want.length === got.length && want.every(name => got.some(item => normName(item) === normName(name)));
  return same(preset.recipes || [], info.recipes || []) && same(preset.loras || [], info.loras || []);
}

/** 把网页切到预设：MiaoMiao 这类不要 LoRA / Recipe 的，先全部移除再换模型（免得出现「LoRA 與目前模型不相容」）；要的，换完模型再加。 */
async function applyModel(page, id) {
  const preset = MODEL_PRESETS.find(item => item.id === id);
  if (!preset) throw new Error(`没有这个模型预设：${id}`);
  await ensureModelPanel(page);
  if (!preset.loras?.length) await removeLoras(page);
  if (!preset.recipes?.length) await removeRecipes(page);
  await chooseModel(page, preset);
  for (const lora of preset.loras || []) await ensureLora(page, lora);
  for (const recipe of preset.recipes || []) await ensureRecipe(page, recipe);
  console.log(`模型预设已就绪：${preset.name}`);
}

/**
 * 写提示词。输入框里有 LoRA 触发词芯片时（不可编辑的节点，全选也删不掉），只替换芯片后面的文字，芯片不动；
 * 没有芯片就和原来一样用 fill。
 */
async function fillPrompt(page, editor, prompt) {
  const chipSel = 'span.node-lora-trigger-words';
  const chips = await editor.locator(chipSel).count();
  if (!chips) { await editor.fill(prompt); return; }
  await editor.focus();
  await editor.evaluate((root, sel) => {
    const all = root.querySelectorAll(sel);
    const last = all[all.length - 1];
    const range = document.createRange();
    range.setStartAfter(last);
    range.setEndAfter(root.lastChild);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, chipSel);
  await sleep(150);
  await page.keyboard.insertText(prompt);
  await sleep(250);
  const ok = await editor.evaluate((root, args) => {
    const plain = value => String(value || '').replace(/\s+/g, '');
    const text = plain(root.innerText);
    return root.querySelectorAll(args.sel).length === args.chips && text.endsWith(plain(args.prompt).slice(-40)) && text.length <= plain(args.prompt).length + 200;
  }, { sel: chipSel, chips, prompt });
  if (!ok) throw new Error('输入框里有 LoRA 触发词芯片，但没能只替换芯片后面的提示词（网页可能改版了）');
}

let settingLock = Promise.resolve();
// 设置 / 记录 / 切号这些排队的活：哪个卡住了，最多占着锁 4 分钟就放手，后面的不再被一个卡死的活永远堵住
const holdLock = (job, ms = 4 * 60 * 1000) => Promise.race([job.catch(() => {}), new Promise(resolve => setTimeout(resolve, ms))]);

// ───────────── API 直连出图（实验）─────────────
// 网页点「生成」时其实是 POST https://api.pixai.art/v2/task/create。这里直接发同样的请求，不再点网页：
// 切模型 / LoRA / Recipe 变成改请求里的 ID，瞬间完成。令牌和 x-u3t 等头从页面自己发出的请求里实时抄下来（不需要手填）。
// 任何一步没法走 API（抄不到头、被拒、网络不通）而任务还没提交成功，就自动退回原来的网页点击；提交成功之后出错不会再退回（免得重复扣积分）。
// PIXAI_API=0 可以整个关掉。
const API = { on: env('PIXAI_API', '1') !== '0', base: 'https://api.pixai.art', staleMs: 50 * 60 * 1000 };
const live = { headers: null, at: 0 };
const watched = new WeakSet();
const API_KEEP = ['authorization', 'x-u3t', 'x-browser-id', 'x-pricing-script-version'];

/** 记下页面发给 api.pixai.art 的请求头（令牌、x-u3t 每小时会变，页面自己会更新，我们每次都用最新的）。 */
function watchApiHeaders(page) {
  if (!page || watched.has(page)) return;
  watched.add(page);
  page.on('request', request => {
    try {
      if (!request.url().startsWith(API.base + '/')) return;
      const h = request.headers();
      if (!h.authorization) return;
      const picked = {};
      for (const key of API_KEEP) if (h[key]) picked[key] = h[key];
      live.headers = picked; live.at = Date.now();
    } catch { /* 抄不到就算了，会退回网页 */ }
  });
}
// ── 网页设置记录：用户在网页上把模型、LoRA、Recipe、步数……都设好，在插件里点「记录」，再到网页上点一次「生成」，
// 反代把页面发出的这条请求拦下来记成一条记录（不真的提交、不扣积分）。可以记好几条，API 模式的「网页设置」来源选其中一条，
// 只换提示词、分辨率、张数，LoRA 还可以逐个开关、调权重。我们自己发的请求不记。
let lastCost = null; // 最近一次 API 出图实际扣的积分（任务提交时 PixAI 回的 paidQuota）
let tpls = [], tplCurrent = '', lastOwnBody = '';
const TPL_MAX = 12;
const TPL_FILE = () => path.join(ACCOUNT_DIR, 'template.json');
async function saveTemplates() { try { await fs.mkdir(ACCOUNT_DIR, { recursive: true }); await fs.writeFile(TPL_FILE(), JSON.stringify({ list: tpls, current: tplCurrent }), { mode: 0o600 }); } catch (error) { console.warn('网页设置没能存盘：', error.message); } }
/** 记录里自带的提示词（页面上写的、模板带的）一律不要：出图的提示词只由酒馆给。负面词和 LoRA 触发词是设置，不动。 */
function stripPrompts(q) {
  const gone = [];
  for (const key of Object.keys(q)) if (/prompt/i.test(key) && key !== 'negativePrompts' && key !== 'promptHelper') { gone.push(key); delete q[key]; }
  if (q.extra && typeof q.extra === 'object') for (const key of Object.keys(q.extra)) if (/prompt/i.test(key)) { gone.push('extra.' + key); delete q.extra[key]; }
  return gone;
}
const tplById = id => tpls.find(item => item.id === id) || tpls.find(item => item.id === tplCurrent) || tpls[tpls.length - 1] || null;
function rememberTemplate(text) {
  if (!text || text === lastOwnBody) return false;
  const body = json(text, null);
  if (!body || typeof body !== 'object' || !body.parameters || typeof body.parameters !== 'object' || !body.parameters.modelId) return false;
  const gone = stripPrompts(body.parameters);
  const rec = { id: 't' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), at: new Date().toISOString(), body };
  tpls.push(rec); while (tpls.length > TPL_MAX) tpls.shift();
  tplCurrent = rec.id;
  console.log('已记下网页上的出图设置：', templateInfo(rec).summary + (gone.length ? `（已去掉自带的提示词：${gone.join('、')}）` : ''));
  saveTemplates();
  return true;
}
/** API 请求里只有 LoRA 的版本号，名字靠预设里同位置的名字认；认不出的显示版本号尾巴和触发词。 */
function loraNameOf(versionId) {
  for (const [id, model] of Object.entries(API_MODELS)) {
    const at = (model.loras || []).findIndex(l => l.versionId === versionId), preset = MODEL_PRESETS.find(item => item.id === id);
    if (at >= 0 && preset?.loras?.[at]) return preset.loras[at];
  }
  return '';
}
function templateInfo(rec) {
  const q = rec.body.parameters, id = Object.keys(API_MODELS).find(key => API_MODELS[key].modelId === q.modelId);
  const model = id ? MODEL_PRESETS.find(item => item.id === id)?.name || id : `模型 ${String(q.modelId).slice(-6)}`;
  const given = Array.isArray(q.loraParameters) ? q.loraParameters : [];
  const loras = Object.keys(q.lora || {}).map(versionId => {
    const hit = given.find(l => String(l.versionId) === versionId);
    return { id: versionId, name: loraNameOf(versionId) || `LoRA …${versionId.slice(-5)}`, weight: Number.isFinite(Number(q.lora[versionId])) ? Number(q.lora[versionId]) : 0.7, trigger: String(hit?.triggerWords || '').slice(0, 60) };
  });
  // Recipe 的字段名不一定叫 recipeIds：参数里名字带 recipe 的数组 / 对象 / 单个 id 都算（含 extra 里的）。
  const recipeIds = [];
  const scan = (obj, depth) => { if (!obj || typeof obj !== 'object' || depth > 2) return; for (const [k, v] of Object.entries(obj)) {
    if (/recipe/i.test(k)) { if (Array.isArray(v)) recipeIds.push(...v.map(x => String(x?.id ?? x?.recipeId ?? x))); else if (v && typeof v === 'object') recipeIds.push(...Object.keys(v)); else if (v) recipeIds.push(String(v)); }
    else if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'lora') scan(v, depth + 1); } };
  scan(q, 0);
  const recipeUniq = [...new Set(recipeIds.filter(Boolean))];
  const recipes = recipeUniq.length;
  const recipeList = recipeUniq.map(rid => { let name = ''; for (const [mid, m] of Object.entries(API_MODELS)) { const at = (m.recipeIds || []).indexOf(rid), pre = MODEL_PRESETS.find(item => item.id === mid); if (at >= 0 && pre?.recipes?.[at]) name = pre.recipes[at]; } return { id: rid, name: name || `Recipe …${rid.slice(-5)}` }; });
  return { id: rec.id, at: rec.at, model, loras, recipes, recipeList, steps: q.samplingSteps ?? null, width: Number.isInteger(q.width) ? q.width : null, height: Number.isInteger(q.height) ? q.height : null, summary: `${model}，LoRA ${loras.length} 个，Recipe ${recipes} 个${q.samplingSteps ? '，' + q.samplingSteps + ' 步' : ''}` };
}
const templateState = () => ({ armed: !!armed, current: tplById(tplCurrent)?.id || '', list: tpls.map(templateInfo) });
let armed = null; // { page, handler, timer }
async function disarmTemplate() {
  if (!armed) return;
  clearTimeout(armed.timer);
  await armed.page.unroute('**/v2/task/create*', armed.handler).catch(() => {});
  armed = null;
}
/** 等页面的下一次「生成」：拦下来（不真的提交，不扣积分），把它的设置记成一条记录。 */
async function armTemplate(page, seconds = 120) {
  await disarmTemplate();
  const handler = async route => {
    try {
      const request = route.request();
      if (request.method() !== 'POST' || request.postData() === lastOwnBody) return await route.continue();
      if (!rememberTemplate(request.postData())) return await route.continue();
      await route.abort().catch(() => {});
    } catch (error) { console.warn('拦网页「生成」时出错，放行：', error.message); await route.continue().catch(() => {}); }
    await disarmTemplate();
  };
  await page.route('**/v2/task/create*', handler);
  armed = { page, handler, timer: setTimeout(() => { disarmTemplate(); console.log('等网页点「生成」超时，已取消记录设置'); }, seconds * 1000) };
}
fs.readFile(path.join(env('ACCOUNT_DIR', path.join(process.cwd(), 'accounts')), 'template.json'), 'utf8').then(text => {
  const v = json(text, null);
  if (v && Array.isArray(v.list)) { tpls = v.list.filter(item => item && item.id && item.body?.parameters); tplCurrent = String(v.current || ''); }
  else if (v && v.body?.parameters) { tpls = [{ id: 't0', at: v.at || new Date().toISOString(), body: v.body }]; tplCurrent = 't0'; } // 旧版只存一条
}).catch(() => {});

const apiReady = () => API.on && !!live.headers && Date.now() - live.at < API.staleMs;

// 模型的 API 参数（从网页真实请求里抄的）。预设用 PIXAI_MODELS 自定义时，可以在预设里带 api 字段覆盖。
const API_MODELS = {
  miaomiao: {
    modelId: '1973907975378727151',
    params: { samplingSteps: 30, samplingMethod: 'Euler a', cfgScale: 5.5, clipSkip: 2 },
    negative: 'lowres,(bad),bad hands,limb asymmetry,bad feet,text,error,fewer,extra,missing,worst quality,jpeg artifacts,low quality,watermark,unfinished,displeasing,oldest,early,chromatic aberration,signature,simple_background,artistic error,username,scan,[abstract],english text,shiny_skin,',
    loras: [], recipeIds: []
  },
  tsubaki2: {
    modelId: '1983308862240288769',
    params: { inferenceProfile: 'lite' },
    negative: 'nsfw, lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry',
    loras: [{ versionId: '2075209401690015736', weight: 0.7, triggerWords: 'real, cosplay, 2.5d, semi-real, chinese, cosplayer' }],
    recipeIds: ['2055413048108966308']
  }
};
const apiModelOf = id => { const preset = MODEL_PRESETS.find(item => item.id === id); return preset ? (preset.api || API_MODELS[id] || null) : null; };

// API 模式下「现在选的模型」由反代自己记（不动网页）。没选过就取网页上现在的，再不行取默认的。
let apiModelId = null;
async function currentModelId(page) {
  if (apiModelId) return apiModelId;
  const info = await readModelInfo(page).catch(() => null);
  const hit = info && MODEL_PRESETS.find(item => modelMatches(item, info.name) && apiModelOf(item.id));
  const fallback = MODEL_PRESETS.find(item => modelMatches(item, CONFIG.model) && apiModelOf(item.id)) || MODEL_PRESETS.find(item => apiModelOf(item.id));
  return (hit || fallback)?.id || null;
}

/** PixAI 说「不行」的话，翻成人话：积分不足、审核拒绝、登录过期、太频繁各说各的，并且不再退回网页重试（重试只会再被拒一次）。 */
function explainPixai(text) {
  const raw = String(text || '');
  if (/insufficient|not[ _-]?enough|no[ _-]?(credit|quota|point)|out of (credit|quota|point)|quota[ _-]?(exceed|limit|not)|balance|积分不足|點數不足|点数不足|余额不足|不足以|不够|credits? (are|is)? ?(low|required)/i.test(raw)) return 'PixAI 积分不足：这次没有出图（没有扣费）。去网页签到领积分或充值，再重画';
  if (/NSFW|moderat|prohibit|sensitive|forbidden prompt|policy|审核|违规|违反|敏感|不允许|不当/i.test(raw)) return 'PixAI 审核拒绝了这条提示词（含敏感内容）：这次没有出图，也不会重试。改一改画面描述，或换一个更保守的画风再画';
  if (/too many|rate[ _-]?limit|429|太频繁|请求过多|稍后再试/i.test(raw)) return 'PixAI 说请求太频繁：稍等一两分钟再画';
  if (/unauthori[sz]ed|token|expired|login|sign ?in|未登录|登录|过期/i.test(raw)) return 'PixAI 登录已失效：打开 6080 远程浏览器重新登录 PixAI，再回来画';
  return '';
}
const apiFail = (message, fallback, extra = {}) => Object.assign(new Error(message), { fallback, ...extra });

/** 在 PixAI 页面里发请求（带上页面的 cookie 和抄来的头）。 */
async function apiCall(page, method, path, body) {
  if (!apiReady()) throw apiFail('还没有抄到页面的请求头（页面刚打开或太久没动）', true);
  // 网络挂住 / 页面崩了都不能一直等：页面里的 fetch 60 秒掐掉，外面再兜 90 秒
  const run = page.evaluate(async ({ url, method, headers, body }) => {
    try {
      const response = await fetch(url, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body, credentials: 'include', signal: AbortSignal.timeout(60000) });
      return { status: response.status, text: await response.text() };
    } catch (error) { return { status: 0, text: String(error && error.message || error) }; }
  }, { url: API.base + path, method, headers: live.headers, body: body ? JSON.stringify(body) : undefined });
  let timer;
  const result = await Promise.race([run, new Promise(resolve => { timer = setTimeout(() => resolve({ status: 0, text: '请求超时（页面没有回应）' }), 90000); })]).finally(() => clearTimeout(timer));
  run.catch(() => {});
  return { status: result.status, text: result.text, json: json(result.text, null) };
}

async function apiGenerate(page, prompt, count, spec = null) {
  // 刚启动或页面刚打开时还没抄到头：页面自己每几秒会发请求，等一会儿
  for (let i = 0; i < 30 && !apiReady(); i++) await sleep(500);
  // 插件在 API 模式下把模型、宽高、LoRA 权重都带在请求里：不碰网页、不用页面上选着的东西
  const fromPage = spec?.source === 'page';
  const id = fromPage ? null : spec?.model || await currentModelId(page);
  const model = fromPage ? null : id && apiModelOf(id);
  const rec = fromPage ? tplById(spec.template) : null;
  if (fromPage && !rec) throw apiFail('还没有记下网页上的设置：到 PixAI 参数里点「记录网页设置」，再去网页上点一次「生成」', false);
  if (!fromPage && !model) throw apiFail(spec ? `API 模式没有这个模型：${id || '还没选模型'}` : '没有这个模型的 API 参数', true);
  let width = spec?.width, height = spec?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    if (spec) throw apiFail('请求里没有分辨率：先在插件的 PixAI 参数里选好比例和尺寸', false);
    const status = await readPageStatus(page).catch(() => null);
    width = status?.resolution?.width; height = status?.resolution?.height;
    if (!Number.isInteger(width) || !Number.isInteger(height)) throw apiFail('读不到网页上的分辨率', true);
  }
  const weightOf = lora => Number.isFinite(spec?.loraWeight) ? Math.min(1, Math.max(0, spec.loraWeight)) : lora.weight;

  const useLora = spec?.useLora !== false, useRecipe = spec?.useRecipe !== false;
  const parameters = fromPage ? (() => {
    // 网页设置当底：只换提示词、分辨率、张数；种子留空 = 每次随机
    const q = JSON.parse(JSON.stringify(rec.body.parameters));
    stripPrompts(q); // 以前记下的老记录里可能还带着提示词
    // LoRA 逐个可开关、可调权重（酒馆里选的）；没提的保持记录里的样子
    if (q.lora && typeof q.lora === 'object') {
      for (const versionId of Object.keys(q.lora)) {
        const tweak = spec.loraTweaks?.[versionId];
        if (!tweak) continue;
        if (tweak.on === false) delete q.lora[versionId]; else if (Number.isFinite(tweak.weight)) q.lora[versionId] = tweak.weight;
      }
      if (Array.isArray(q.loraParameters)) q.loraParameters = q.loraParameters.filter(l => String(l.versionId) in q.lora).map(l => ({ ...l, weight: q.lora[String(l.versionId)] }));
      if (!Object.keys(q.lora).length) { delete q.lora; delete q.loraParameters; }
    }
    // Recipe 逐个可关（酒馆里记录的编辑页）：名字带 recipe 的字段里去掉被关的 id
    const off = new Set(Object.entries(spec?.loraTweaks || {}).filter(([, t]) => t && t.on === false).map(([k]) => k));
    if (off.size) {
      const strip = obj => { if (!obj || typeof obj !== 'object') return; for (const k of Object.keys(obj)) {
        if (/recipe/i.test(k)) { const v = obj[k]; if (Array.isArray(v)) { obj[k] = v.filter(x => !off.has(String(x?.id ?? x?.recipeId ?? x))); if (!obj[k].length) delete obj[k]; } else if (v && typeof v === 'object') { for (const key of Object.keys(v)) if (off.has(key)) delete v[key]; if (!Object.keys(v).length) delete obj[k]; } else if (off.has(String(v))) delete obj[k]; }
        else if (k !== 'lora' && obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) strip(obj[k]); } };
      strip(q);
    }
    q.prompts = prompt; q.extra = { ...(q.extra || {}), naturalPrompts: prompt }; q.width = width; q.height = height; q.seed = '';
    if (count > 1) q.batchSize = count; else delete q.batchSize;
    return q;
  })() : {
    extra: { naturalPrompts: prompt }, priority: 1000, width, height, prompts: prompt, modelId: model.modelId,
    negativePrompts: model.negative, seed: '', ...model.params, controlNets: [],
    ...(count > 1 ? { batchSize: count } : {}),
    ...(useLora && model.loras.length ? { lora: Object.fromEntries(model.loras.map(l => [l.versionId, weightOf(l)])), loraParameters: model.loras.map(l => ({ weight: weightOf(l), versionId: l.versionId, positionInfo: { startIndex: 0, endIndex: 0 }, triggerWords: l.triggerWords || '' })) } : {}),
    ...(useRecipe && model.recipeIds.length ? { recipeIds: model.recipeIds } : {}),
    promptHelper: { withStage: true, userWantToEnable: true, forcePromptHelperDetectionSide: 'server' }
  };
  const createBody = { ...(fromPage ? { ...rec.body } : {}), parameters };
  lastOwnBody = JSON.stringify(createBody);
  const created = await apiCall(page, 'POST', '/v2/task/create', createBody);
  if (created.status === 0) throw apiFail('API 请求没发出去：' + created.text, true);
  if (created.status < 200 || created.status >= 300 || !created.json?.id) {
    if (created.status === 401 || created.status === 403) live.headers = null; // 头过期了，等页面发下一个请求再抄
    const why = explainPixai(created.text);
    if (why) throw apiFail(why + `（HTTP ${created.status}）`, false);
    throw apiFail(`API 提交没成功（${created.status}）：${String(created.text).slice(0, 200)}`, true);
  }
  const taskId = String(created.json.id);
  lastCost = { points: Number.isFinite(Number(created.json.paidQuota)) ? Number(created.json.paidQuota) : null, count, width, height, at: Date.now() };
  console.log(`API 已提交任务 ${taskId}（${fromPage ? '网页设置：' + templateInfo(rec).summary : MODEL_PRESETS.find(item => item.id === id).name + (useLora ? '' : '，不带 LoRA') + (useRecipe ? '' : '，不带 Recipe')}，${width}×${height}，${count} 张，${created.json.paidQuota ?? '?'} 积分）`);

  // 提交成功之后再出错就不能退回网页了（会重复扣积分）
  const deadline = Date.now() + 5 * 60 * 1000;
  let task = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    const listed = await apiCall(page, 'GET', '/v2/user/me/tasks?first=10');
    if (listed.status === 401 || listed.status === 403) throw apiFail(`查任务状态被拒绝（${listed.status}），任务 ${taskId} 已提交，请稍后在网页上看`, false);
    task = listed.json?.data?.find(item => String(item.id) === taskId) || null;
    if (task && /^(failed|cancelled|canceled)$/i.test(task.status || '')) throw apiFail(explainPixai(JSON.stringify(task)) || `PixAI 任务 ${taskId} ${task.status}（网页那边没给原因，可能被审核拒绝或积分不足）`, false);
    if (task && task.status === 'completed' && task.outputs?.mediaUrls?.length) break;
    task = null;
  }
  if (!task) throw apiFail(`等了 5 分钟 PixAI 任务 ${taskId} 还没出完`, false);
  const urls = task.outputs.mediaUrls;
  if (urls.length < count) console.warn(`PixAI 任务 ${taskId} 要 ${count} 张，只出了 ${urls.length} 张`);
  const files = [];
  for (let i = 0; i < urls.length; i++) {
    const response = await page.context().request.get(urls[i], { timeout: 60000 });
    if (!response.ok()) throw apiFail(`第 ${i + 1} 张图片下载失败（${response.status()}）`, false);
    const data = await response.body();
    if (data.length < 100) throw apiFail(`第 ${i + 1} 张图片文件无效`, false);
    const ext = (/\.(png|jpe?g|webp)(\?|$)/i.exec(urls[i]) || [])[1] || ({ 'image/png': 'png', 'image/jpeg': 'jpg' }[response.headers()['content-type']] || 'webp');
    files.push({ name: `image_${i}.${ext}`, data });
  }
  console.log(`API 任务 ${taskId} 完成：要 ${count} 张，出了 ${files.length} 张`);
  return { taskId, files };
}

/** 选模型：API 模式下只记下来（出图时直接用它的 ID，瞬间完成）；API 用不了就去网页上一步步切。 */
async function chooseModelPreset(page, id, onPage = false) { // onPage：插件在「直控」模式里点的，一定要真的去网页上切
  if (!MODEL_PRESETS.some(item => item.id === id)) throw new Error(`没有这个模型预设：${id}`);
  if (!onPage && apiReady() && apiModelOf(id)) { apiModelId = id; console.log(`API 模式：模型选为 ${MODEL_PRESETS.find(item => item.id === id).name}（出图时生效，网页不动）`); return true; }
  await withRetry(page, '模型', async () => { await applyModel(page, id); return await modelIsRight(page, id); });
  apiModelId = id;
  return true;
}

async function generateBatch(prompt, count, spec = null) {
  await settingLock;
  const epoch = ++genEpoch;
  generating = true; genStart = Date.now();
  await disarmTemplate().catch(() => {});
  try {
    const page = await getPixAIPage();
    watchApiHeaders(page);
    // 酒馆插件明说了模式：API 就只走 API（失败直接报错，不偷偷改走网页）；直控就只点网页。没说（旧插件）才是老办法：先 API，不行退回网页。
    if (spec?.mode === 'api') {
      if (!API.on) throw new Error('反代没开 API 模式（启动参数 PIXAI_API=0），请在插件里切到「直控」');
      try { return await apiGenerate(page, prompt, count, spec); }
      catch (error) { error.fallback = false; throw error; }
    }
    if (API.on && spec?.mode !== 'direct') {
      try { return await apiGenerate(page, prompt, count); }
      catch (error) {
        if (!error.fallback) throw error;
        console.warn('API 出图走不通，改走网页点击：', error.message);
        // 网页上的模型要和 API 模式下选的一致
        if (apiModelId && !(await modelIsRight(page, apiModelId).catch(() => false))) await applyModel(page, apiModelId);
      }
    }
    await dismissDailyReward(page); // 页面刷新过会重新弹签到框，先关掉
    await dismissPopups(page).catch(() => {}); // 上一次留下的「积分不足」之类弹窗，点空白处关掉

    const oldIds = await page.evaluate(selector =>
      Array.from(document.querySelectorAll(selector)).map(card => card.getAttribute('data-task-id')),
      CARD
    );

    const switched = await setQuantity(page, count);
    const needed = switched ? count : CONFIG.pageCount;
    if (!pagePicked) await setRatio(page, CONFIG.ratio).catch(error => console.warn('切换画面比例失败：', error.message));

    const editor = page.locator('div[contenteditable="true"].tiptap.ProseMirror');
    await editor.waitFor({ state: 'visible', timeout: 30000 });
    await fillPrompt(page, editor, prompt);

    const generateButton = page.locator(
      'section.group\\/prompt-box button[data-react-aria-pressable="true"]'
    ).first();

    await generateButton.waitFor({ state: 'visible', timeout: 30000 });
    if (await generateButton.isDisabled()) {
      throw new Error('PixAI 生成按钮当前不可用');
    }
    await generateButton.click();

    // 点了「生成」之后网页可能弹「积分不足」或审核拒绝的提示：边等图边看，看到就立刻报明确的错，不傻等 5 分钟
    let watching = true;
    const refusal = (async () => {
      while (watching) {
        await sleep(1000);
        const said = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="alert"],[data-sonner-toast],[class*="toast" i]')).filter(el => el.offsetParent !== null || getComputedStyle(el).position === 'fixed').map(el => (el.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ')).catch(() => '');
        const why = explainPixai(said);
        if (why) throw new Error(why + `（网页提示：${said.slice(0, 80)}）`);
      }
      return new Promise(() => {});
    })();
    refusal.catch(() => {});

    const taskHandle = await Promise.race([refusal, page.waitForFunction(({ previousIds, card, thumb, min }) => {
      const found = Array.from(document.querySelectorAll(card)).find(item => {
        const id = item.getAttribute('data-task-id');
        return id && !previousIds.includes(id) && item.querySelectorAll(thumb).length >= min;
      });
      return found?.getAttribute('data-task-id') || false;
    }, { previousIds: oldIds, card: CARD, thumb: THUMB, min: needed }, { timeout: 300000 })]).finally(() => { watching = false; });

    const taskId = await taskHandle.jsonValue();
    const card = page.locator(`section[data-testid="mobile-task-card"][data-task-id="${taskId}"]`);

    // 缩略图可能先于任务最终完成出现；先确认图片已加载且任务卡连续稳定，再开始下载。
    await waitForTaskReady(page, card, needed);
    // 以卡片上实际有几张为准，不写死 4
    const actual = await card.locator(THUMB).count();
    if (actual < needed) throw new Error(`PixAI 任务缩略图不足：${actual}/${needed} 张`);
    const files = await collectDownloads(page, card, actual);
    console.log(`PixAI 任务 ${taskId} 完成：要 ${count} 张，网页出了 ${actual} 张`);
    return { taskId, files };
  } finally {
    if (genEpoch === epoch) generating = false; // 被「重试」放弃的旧任务，不能把新任务的状态清掉
  }
}

// 一次出图最多等 9 分钟：网页没反应、下载卡住都会在这里放弃，不让整条队列一直挂着
const generateWithDeadline = async (...args) => {
  let timer;
  try {
    return await Promise.race([generateBatch(...args), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('出图超过 9 分钟没有结果，已放弃这次（可以直接重画；反代那边若画好了，网页历史里能看到）')), 9 * 60 * 1000); })]);
  } finally { clearTimeout(timer); }
};
const batcher = new Batcher({
  generate: generateWithDeadline,
  counts: CONFIG.counts,
  runTtlMs: CONFIG.runTtlMs,
  legacySize: CONFIG.legacySize,
  legacyTtlMs: CONFIG.legacyTtlMs
});

app.get('/health', async (_req, res) => {
  try {
    const page = await getPixAIPage();
    res.json({ status: 'ok', page: page.url(), generating, runs: batcher.runs.size, counts: CONFIG.counts, quantitySwitch: Object.keys(CONFIG.qty).length ? Object.keys(CONFIG.qty) : 'auto' });
  } catch (error) {
    res.status(503).json({ status: 'error', message: error.message });
  }
});

// 列出生图页上能点的控件，用来找「一次出几张」的选择器：curl http://127.0.0.1:3188/debug/controls
app.get('/debug/controls', async (_req, res) => {
  try {
    const page = await getPixAIPage();
    const items = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, [role="radio"], [role="tab"], [role="option"], [role="switch"], input'))
        .filter(el => el.offsetWidth || el.offsetHeight)
        .slice(0, 150)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || '').trim().slice(0, 30),
          aria: el.getAttribute('aria-label') || '',
          testid: el.getAttribute('data-testid') || '',
          role: el.getAttribute('role') || '',
          checked: el.getAttribute('aria-checked') || el.getAttribute('aria-pressed') || el.getAttribute('data-selected') || ''
        }))
    );
    res.json(items);
  } catch (error) {
    res.status(503).json({ message: error.message });
  }
});

// 积分数字是 NumberFlow 动画组件画在 shadow DOM 里的，网页文字读不到；数值通过无障碍树的名字暴露，用 CDP 读。
const BALANCE_HOST = `(() => { const b = Array.from(document.querySelectorAll('button')).find(el => /^(儲值|储值|充值)$/.test(el.textContent.trim())); return (b && b.parentElement && b.parentElement.querySelector('number-flow-react')) || null; })()`;
const COST_HOST = `(() => { const g = document.querySelector('section[class*="group/prompt-box"] button[data-react-aria-pressable="true"]'); return (g && g.querySelector('number-flow-react')) || null; })()`;

async function axName(page, expression) {
  let client;
  try {
    client = await page.context().newCDPSession(page);
    const { result } = await client.send('Runtime.evaluate', { expression });
    if (!result?.objectId) return null;
    const { node } = await client.send('DOM.describeNode', { objectId: result.objectId });
    const { nodes } = await client.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
    return nodes?.[0]?.name?.value ?? null;
  } catch {
    return null;
  } finally {
    await client?.detach().catch(() => {});
  }
}

const toNumber = v => {
  const m = String(v ?? '').replace(/,/g, '').match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  return m ? Number(m[1]) : null;
};

// 读取页面上当前的出图设置和积分。只读，不点任何东西，生成过程中也能调用；读不到的字段返回 null，不猜。
async function readPageStatus(page, debug = false) {
  const { out, hasBalHost, hasCostHost } = await page.evaluate(debug => {
    const visible = el => !!(el.offsetWidth || el.offsetHeight);
    const text = el => (el.innerText || '').replace(/\s+/g, ' ').trim();
    const clean = (html, n) => html
      .replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/<img[^>]*>/g, '<img/>')
      .replace(/ (class|style|id|data-rac|data-react-aria-pressable|tabindex)="[^"]*"/g, '')
      .replace(/\s+/g, ' ').slice(0, n);
    const toNum = v => { const m = String(v ?? '').replace(/,/g, '').match(/^\s*(\d+(?:\.\d+)?)\s*$/); return m ? Number(m[1]) : null; };
    const hint = el => String(el.className || '').split(/\s+/).filter(c => /ring-|selected|violet|border-|bg-neutral/.test(c)).slice(0, 8).join(' ');
    const buttons = Array.from(document.querySelectorAll('button, [role="radio"]')).filter(visible);

    const isOn = el => {
      const a = n => el.getAttribute(n);
      return a('aria-checked') === 'true' || a('aria-pressed') === 'true' || a('aria-selected') === 'true' ||
        a('data-selected') === 'true' || a('data-pressed') === 'true' || ['on', 'checked', 'active', 'selected'].includes(a('data-state'));
    };
    // 比例按钮：选中的带 ring-neutral-700（从页面实际 HTML 看出）；其余情况退回「样式上唯一不同」
    const marked = el => isOn(el) || /(^|\s)ring-neutral-700(\s|$)/.test(String(el.className || ''));
    const pickSelected = group => {
      const hit = group.find(marked);
      if (hit) return hit;
      if (group.length < 2) return null;
      const sig = el => { const st = getComputedStyle(el); return [st.backgroundColor, st.borderTopColor, st.boxShadow, st.color, st.fontWeight].join('|'); };
      const counts = new Map();
      group.forEach(el => counts.set(sig(el), (counts.get(sig(el)) || 0) + 1));
      const odd = group.filter(el => counts.get(sig(el)) === 1);
      return odd.length === 1 ? odd[0] : null;
    };

    const flowInfo = host => {
      if (!host) return null;
      const d = host.data;
      const sr = host.shadowRoot;
      return {
        fromData: d ? String(d.valueAsString ?? d.value ?? '') || null : null,
        fromAria: host.getAttribute('aria-label'),
        shadowText: sr ? (sr.textContent || '').replace(/\s+/g, '') : null,
        shadowHtml: debug && sr ? clean(sr.innerHTML, 1500) : undefined
      };
    };

    // 一次出几张
    const radios = buttons.filter(el => el.getAttribute('role') === 'radio');
    const countEl = pickSelected(radios);
    const countLabel = countEl ? text(countEl) : null;
    let count = null;
    if (countLabel) {
      const m = /(\d+)\s*[張张]/.exec(countLabel) || /x\s*(\d+)/i.exec(countLabel);
      count = m ? Number(m[1]) : /單張|单张/.test(countLabel) ? 1 : null;
    }

    // 分辨率
    const ratios = buttons.filter(el => /^\d+:\d+$/.test(text(el)));
    const sizes = buttons.filter(el => /^[A-Z]{1,3}\s*\d+\s*[×x]\s*\d+$/i.test(text(el)));
    const ratioEl = pickSelected(ratios);
    const sizeEl = pickSelected(sizes);
    const sm = sizeEl ? /([A-Z]{1,3})\s*(\d+)\s*[×x]\s*(\d+)/i.exec(text(sizeEl)) : null;

    // 剩余积分：「儲值」按钮同一容器里的 number-flow 组件
    const topup = Array.from(document.querySelectorAll('button')).find(el => /^(儲值|储值|充值)$/.test(el.textContent.trim()));
    const balHost = topup && topup.parentElement ? topup.parentElement.querySelector('number-flow-react') : null;
    const bal = flowInfo(balHost);
    const balance = bal ? (toNum(bal.fromData) ?? toNum(bal.fromAria)) : null;

    // 消耗积分：生成按钮上的数字
    const gen = document.querySelector('section[class*="group/prompt-box"] button[data-react-aria-pressable="true"]');
    const costHost = gen ? gen.querySelector('number-flow-react') : null;
    const costInfo = flowInfo(costHost);
    const genText = gen ? (gen.textContent || '').replace(/\s+/g, ' ').trim() : null;
    // 实测：生成按钮里「啟動！」那段有个只含数字的 span（如 4,200），其余文字都不是纯数字
    const costSpan = gen ? Array.from(gen.querySelectorAll('span')).find(el => !el.children.length && /^\d[\d,]*$/.test((el.textContent || '').trim())) : null;
    const cost = costSpan ? toNum(costSpan.textContent) : null;

    const lockedEl = el => !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'));
    const sizeOf = el => { const m = /([A-Z]{1,3})\s*(\d+)\s*[×x]\s*(\d+)/i.exec(text(el)); return m ? { size: m[1].toUpperCase(), width: Number(m[2]), height: Number(m[3]), label: text(el), on: marked(el), locked: lockedEl(el) } : null; };
    const out = {
      count,
      countLabel,
      canSwap: !!document.querySelector('button[aria-label="切換橫豎"]'),
      resolution: {
        ratios: ratios.map(el => ({ ratio: text(el), on: marked(el), locked: lockedEl(el) })),
        sizes: sizes.map(sizeOf).filter(Boolean),
        ratio: ratioEl ? text(ratioEl) : null,
        size: sm ? sm[1].toUpperCase() : null,
        width: sm ? Number(sm[2]) : null,
        height: sm ? Number(sm[3]) : null,
        label: sizeEl ? text(sizeEl) : null
      },
      cost,
      balance
    };

    if (debug) {
      out.raw = {
        balanceFlow: bal,
        costFlow: costInfo,
        generateButtonText: genText,
        generateButtonHtml: gen ? clean(gen.outerHTML, 1500) : null,
        radios: radios.map(el => ({ text: text(el), on: marked(el) })),
        ratios: ratios.map(el => ({ text: text(el), on: marked(el), hint: hint(el) })),
        sizes: sizes.map(el => ({ text: text(el), on: marked(el), hint: hint(el) })),
        numberFlows: Array.from(document.querySelectorAll('number-flow-react')).slice(0, 10).map(el => {
          const btn = el.closest('button');
          return { inButton: btn ? (btn.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : null, info: flowInfo(el) };
        })
      };
    }
    return { out, hasBalHost: !!balHost, hasCostHost: !!costHost };
  }, debug);

  // 页面里读不到数值时，用无障碍树的名字兜底
  let axBalance = null, axCost = null;
  if (out.balance === null && hasBalHost) { axBalance = await axName(page, BALANCE_HOST); out.balance = toNumber(axBalance); }
  if (out.cost === null && hasCostHost) { axCost = await axName(page, COST_HOST); out.cost = toNumber(axCost); }
  if (debug) out.raw.ax = { balance: axBalance, cost: axCost };
  // 模型：插件据此显示现在用的是哪个预设（读网页上实际选着的，不是反代自己记的）
  const info = await readModelInfo(page).catch(() => null);
  out.models = MODEL_PRESETS.map(({ id, name }) => ({ id, name }));
  out.model = info ? { id: MODEL_PRESETS.find(item => modelMatches(item, info.name))?.id || null, name: info.name, recipes: info.recipes, loras: info.loras } : null;
  // API 模式下出图用的是反代记着的预设，不是网页上选着的：按它报告
  out.api = { on: API.on, ready: apiReady(), model: API.on ? apiModelId : null };
  // API 模式用：能用 API 的模型（带 LoRA 默认权重）和读好的分辨率表
  out.apiModels = MODEL_PRESETS.filter(item => apiModelOf(item.id)).map(item => ({ id: item.id, name: item.name, loras: (apiModelOf(item.id).loras || []).map(l => ({ weight: l.weight })), recipes: (apiModelOf(item.id).recipeIds || []).length }));
  out.template = templateState();
  out.lastCost = lastCost;
  out.resolutions = resTable ? { at: resTable.at, ratios: resTable.ratios } : null;
  if (API.on && apiModelId) {
    const preset = MODEL_PRESETS.find(item => item.id === apiModelId), spec = apiModelOf(apiModelId);
    if (preset) out.model = { id: preset.id, name: preset.name, recipes: preset.recipes || [], loras: preset.loras || [], viaApi: true };
  }
  return out;
}

// 给酒馆插件取的参数：GET /ai/status（带密钥时同样要 Authorization）；加 ?debug=1 会多返回原始节点信息，用来校准选择器
app.get('/ai/status', async (req, res) => {
  try {
    const page = await getPixAIPage();
    const status = await readPageStatus(page, req.query.debug === '1');
    noteBalance(status.balance);
    res.json({ ok: true, generating, ...status, updatedAt: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ ok: false, message: error.message });
  }
});

// 调试：导出顶栏（积分）、提示词框（生成按钮）、设置区（张数/比例/尺寸）的 HTML，用来校准选择器：curl http://127.0.0.1:3188/debug/dom
// 给酒馆插件切网页参数：POST /ai/settings  {"count": 1|4, "ratio": "9:16", "size": "M", "swap": true, "model": "tsubaki2"}，
// 都可以不带，带哪个切哪个（顺序：模型 → 张数 → 比例 → 尺寸 → 横竖互换）。回的内容和 /ai/status 一样。
// 选过比例/尺寸/横竖之后，出图前不再按 PIXAI_RATIO 切回去。只带 count 的旧插件请求照常能用。
app.post('/ai/settings', async (req, res) => {
  const body = req.body || {};
  const want = {};
  if (body.model !== undefined) {
    want.model = String(body.model).trim();
    if (!MODEL_PRESETS.some(item => item.id === want.model)) return res.status(400).json({ ok: false, message: `模型只能是：${MODEL_PRESETS.map(item => item.id).join('、')}` });
  }
  if (body.count !== undefined) {
    want.count = Number(body.count);
    if (!CONFIG.counts.includes(want.count)) return res.status(400).json({ ok: false, message: `张数只能是 ${CONFIG.counts.join(' 或 ')}` });
  }
  if (body.ratio !== undefined) {
    want.ratio = String(body.ratio).trim();
    if (!/^\d+:\d+$/.test(want.ratio)) return res.status(400).json({ ok: false, message: '比例要写成 9:16 这样' });
  }
  if (body.size !== undefined) {
    want.size = String(body.size).trim().toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(want.size)) return res.status(400).json({ ok: false, message: '尺寸要写档位字母，如 M、L' });
  }
  if (body.swap === true) want.swap = true;
  if (!Object.keys(want).length) return res.status(400).json({ ok: false, message: '没有要切的内容（model / count / ratio / size / swap）' });
  if (isGenerating()) {
    return res.status(409).json({ ok: false, generating: true, message: '反代正在出图，画完再切' });
  }
  const run = async () => {
    const page = await getPixAIPage();
    const failed = [], reasons = [];
    const attempt = async (label, task, opts) => {
      try { await withRetry(page, label, task, opts); }
      catch (error) { failed.push(label); reasons.push(`${label}：${error.message}`); console.warn(`切换${label}失败：`, error.message); }
    };
    if (want.model !== undefined) await attempt('模型', () => chooseModelPreset(page, want.model, body.direct === true), { tries: 1 });
    if (want.count !== undefined) await attempt('张数', () => setQuantity(page, want.count));
    if (want.ratio !== undefined) { pagePicked = true; await attempt('比例', () => setRatio(page, want.ratio)); }
    if (want.size !== undefined) { pagePicked = true; await attempt('尺寸', () => setSize(page, want.size)); }
    // 横竖是互换：网页慢一点才变的话再点一次会换回去，所以不自动重试（tries: 1）
    if (want.swap) { pagePicked = true; await attempt('横竖', () => swapOrientation(page), { tries: 1 }); }
    await sleep(400);
    const status = await readPageStatus(page);
    return { failed, reasons, status };
  };
  const job = settingLock.then(run);
  settingLock = holdLock(job);
  try {
    const { failed, reasons, status } = await job;
    if (failed.length) {
      return res.status(502).json({ ok: false, generating, ...status, failed, message: `没能在 PixAI 网页上切换：${failed.join('、')}${reasons.length ? '（' + reasons.join('；') + '）' : ''}` });
    }
    res.json({ ok: true, generating, ...status, updatedAt: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ ok: false, message: error.message });
  }
});

// ───────────── 换账号：浏览器打开 /admin（可以给它单独配一个域名），填密钥 + PixAI 邮箱密码，反代清掉旧登录、自动登录新账号 ─────────────
// 必须设置 BRIDGE_TOKEN 才能用（否则任何人都能换你的账号）；密码只经这一次请求送到反代，不落盘、不进日志。请用 HTTPS 域名访问。
const ADMIN_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f3ecff"><title>PixAI 反代 · 账号</title>
<style>
:root{--ink:#4b3a8f;--ink2:#7c5cdb;--muted:#8d84a6;--bg1:#f6f0ff;--bg2:#fdeef6;--card:rgba(255,255,255,.78);--line:#e6dcf7;--field:#fff;--g1:#a78bfa;--g2:#e8a6d0;--gd:#7c5cdb;--pk:#e8629a;--bad:#d4506a;--ok:#3d9d80;--idle:#3d9d80;--glass:rgba(255,255,255,.62);--sh:rgba(140,110,220,.16)}
@media (prefers-color-scheme:dark){:root{--ink:#e2d8ff;--ink2:#bfa9ff;--muted:#9d95bd;--bg1:#241d3d;--bg2:#2d2140;--card:rgba(255,255,255,.07);--line:#3d3360;--field:#2a2347;--bad:#ff8aa0;--ok:#7fd6bf;--idle:#7fd6bf;--glass:rgba(255,255,255,.06);--sh:rgba(0,0,0,.3)}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%;margin:0;overflow:hidden}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;color:var(--ink);
background:radial-gradient(circle at 12% 8%,rgba(255,217,236,.55) 0,transparent 38%),radial-gradient(circle at 92% 22%,rgba(216,200,255,.6) 0,transparent 42%),linear-gradient(160deg,var(--bg1),var(--bg2)) fixed}
.bg{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
.bg i{position:absolute;border-radius:50%;filter:blur(46px);animation:drift 14s ease-in-out infinite}
.bg i:nth-child(1){width:300px;height:300px;left:-90px;bottom:-60px;background:rgba(231,166,210,.42)}
.bg i:nth-child(2){width:340px;height:340px;right:-90px;top:-80px;background:rgba(167,139,250,.38);animation-delay:-6s}
.bg s{position:absolute;width:10px;height:10px;text-decoration:none;opacity:.25;animation:twinkle 4s ease-in-out infinite}
.bg s::before{content:"";position:absolute;inset:0;background:var(--g1);clip-path:polygon(50% 0,62% 38%,100% 50%,62% 62%,50% 100%,38% 62%,0 50%,38% 38%)}
.app{height:100dvh;max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px calc(12px + env(safe-area-inset-bottom))}
/* 顶部：标签 + 品牌 */
.tabs{flex:none;position:relative;display:grid;grid-template-columns:1fr 1fr;width:min(280px,100%);margin:0 auto;padding:4px;border-radius:999px;background:var(--glass);border:1px solid var(--line);box-shadow:0 8px 24px var(--sh);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.tabs button{position:relative;z-index:1;border:0;background:none;font:inherit;font-size:13.5px;font-weight:800;color:var(--muted);padding:8px 10px;border-radius:999px;cursor:pointer;transition:color .3s;touch-action:manipulation;display:flex;align-items:center;justify-content:center;gap:6px}
.tabs button.on{color:#fff}
.tabs button em{font-style:normal;font-size:11px;font-weight:800;min-width:18px;padding:0 5px;border-radius:99px;background:rgba(167,139,250,.25);color:var(--gd)}
.tabs button.on em{background:rgba(255,255,255,.3);color:#fff}
.ind{position:absolute;z-index:0;top:4px;bottom:4px;left:4px;width:calc(50% - 4px);border-radius:999px;background:linear-gradient(100deg,var(--g1),var(--g2));box-shadow:0 6px 16px rgba(150,110,230,.38);transition:transform .5s cubic-bezier(.3,1.25,.4,1)}
.hero{flex:none;display:flex;align-items:center;gap:12px;padding:2px 4px}
.logo{position:relative;flex:none;width:44px;height:44px;border-radius:13px;display:grid;place-items:center;color:#fff;font-weight:900;font-size:17px;letter-spacing:-.5px;background:linear-gradient(135deg,var(--g1),var(--g2));box-shadow:0 8px 20px rgba(150,110,230,.38);animation:floaty 4.5s ease-in-out infinite}
.logo::after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(115deg,transparent 35%,rgba(255,255,255,.55) 50%,transparent 65%);transform:translateX(-120%);animation:shine 3.6s ease-in-out infinite}
.ttl-area{flex:1;min-width:0}
h1{margin:0;font-size:20px;line-height:1.2;letter-spacing:.3px}
h1 b{background:linear-gradient(90deg,#7c5cdb,#e8629a,#ffb86b,#7c5cdb);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:flow 5s linear infinite alternate}
.sub{display:flex;align-items:center;gap:8px;min-width:0;margin-top:3px;font-size:12px;color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12px;color:var(--muted);background:var(--glass);border:1px solid var(--line);white-space:nowrap;transition:color .3s,border-color .3s}
.dot{width:8px;height:8px;border-radius:50%;background:var(--idle)}
.pill.on{color:var(--ink);border-color:var(--g1)}
.pill.on .dot{background:var(--g1);animation:pulse 1.2s ease-in-out infinite}
.pill.stuck{color:var(--bad);border-color:var(--bad)}
.pill.stuck .dot{background:var(--bad);animation:pulse 1s ease-in-out infinite}
.tools{display:flex;gap:8px}
.ib{display:grid;place-items:center;width:36px;height:36px;padding:0;color:var(--ink);background:var(--field);border:1.5px solid var(--line);border-radius:12px;cursor:pointer;transition:transform .15s,box-shadow .2s,border-color .2s}
.ib:hover{box-shadow:0 6px 16px var(--sh);border-color:var(--g1)}
.ib svg,.go svg,.mini svg,.chip svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.ib:active,.go:active,.mini:active{transform:scale(.96)}
.ib.warn{border-color:var(--bad);color:var(--bad)}
.ib.spin svg{animation:spin .7s linear infinite}
/* 工作区 */
.work{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.pane{display:none;flex:1;min-height:0;flex-direction:column;gap:12px;overflow:auto;padding:14px;border-radius:24px;background:var(--card);border:1px solid var(--line);box-shadow:0 18px 44px var(--sh);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.pane.show{display:flex;animation:paneIn .45s cubic-bezier(.2,.8,.2,1) both}
.pane::before{content:"";position:sticky;top:-14px;flex:none;height:3px;margin:-14px -14px 0;background:linear-gradient(90deg,var(--g1),var(--g2),#ffb86b,var(--g1));background-size:200% 100%;animation:flow 6s linear infinite;border-radius:24px 24px 0 0}
.chip{flex:none;align-self:flex-start;display:inline-flex;align-items:center;gap:8px;padding:5px 14px 5px 6px;border-radius:999px;background:linear-gradient(100deg,rgba(167,139,250,.2),rgba(255,158,199,.22));font-size:14.5px;font-weight:800;color:var(--ink2)}
.chip span{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--field);box-shadow:0 3px 8px var(--sh);color:var(--gd)}
.chip svg{width:16px;height:16px}
.blk{flex:none;display:flex;flex-direction:column;gap:10px;animation:rise .55s cubic-bezier(.2,.8,.2,1) both}
.pane.show .blk:nth-child(2){animation-delay:.04s}.pane.show .blk:nth-child(3){animation-delay:.1s}.pane.show .blk:nth-child(4){animation-delay:.16s}.pane.show .blk:nth-child(5){animation-delay:.22s}
.pane>.blk:first-child{position:relative;z-index:30}
.blk.grow{flex:1;min-height:150px}
/* 当前账号 */
.curwrap{position:relative;z-index:20}
.cur{padding:12px 14px;border-radius:20px;background:var(--field);border:1.5px solid var(--g1);box-shadow:0 0 0 3px rgba(167,139,250,.14),0 10px 24px var(--sh);display:flex;flex-direction:column;gap:10px;transition:transform .25s,box-shadow .25s}
.cur .top{display:flex;align-items:center;gap:10px}
.cur .who{flex:1;min-width:0}
.cur .who small{display:block;font-size:11px;font-weight:800;color:var(--ok)}
.cur .em{font-size:15px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pts{flex:none;text-align:right}
.pts b{display:block;font-size:26px;font-weight:900;line-height:1.1;background:linear-gradient(135deg,var(--g1),#d58ac0);-webkit-background-clip:text;background-clip:text;color:transparent;font-variant-numeric:tabular-nums}
.pts small{display:block;font-size:10.5px;color:var(--muted)}
.acts{display:flex;gap:8px}
.mini{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:8px 10px;font:inherit;font-size:13.5px;font-weight:800;color:var(--ink);background:rgba(167,139,250,.13);border:1.5px solid var(--line);border-radius:13px;cursor:pointer;transition:transform .15s,background .2s,box-shadow .2s,border-color .2s;touch-action:manipulation}
.mini svg{width:16px;height:16px}
.mini:hover:not(:disabled){border-color:var(--g1);box-shadow:0 6px 14px var(--sh)}
.mini.stop{color:var(--bad);border-color:rgba(212,80,106,.35);background:rgba(212,80,106,.08)}
.mini:disabled{opacity:.5}
.mini.on{background:linear-gradient(135deg,#a78bfa,#e7a6d2);color:#fff;border-color:transparent;animation:selPop .4s ease}
.mini.swc{flex:none;min-height:32px;padding:5px 12px;font-size:12.5px;align-self:flex-start;background:var(--glass)}
.mini.swc svg{transition:transform .25s}.mini.swc.open svg{transform:rotate(180deg)}
.mini:focus-visible,.ib:focus-visible,.go:focus-visible,.tabs button:focus-visible{outline:2px solid var(--g1);outline-offset:2px}
.mdl{display:flex;flex-direction:column;gap:8px}
.mdl[hidden]{display:none}
.mdlcur{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px}
.mdlcur small{font-size:12px;color:var(--muted)}
.mdlcur b{font-size:14.5px}
.mdlcur em{font-style:normal;font-size:12px;color:var(--muted)}
.mdl .acts{flex-wrap:wrap;gap:6px}.mdl .mini{flex:1 1 auto;min-height:36px;font-size:12.5px;white-space:nowrap}
/* 切换账号浮层 */
.accs{position:absolute;left:0;right:0;top:calc(100% + 8px);z-index:40;display:flex;flex-direction:column;gap:6px;max-height:min(46vh,340px);overflow:auto;padding:8px;border-radius:18px;background:var(--bg2);border:1.5px solid var(--line);box-shadow:0 18px 44px rgba(60,40,120,.3);scrollbar-width:thin;scrollbar-color:var(--line) transparent;animation:pop .18s ease both}
.accs[hidden]{display:none}
/* 账号卡 */
.list{display:flex;flex-direction:column;gap:8px}
.acc{display:flex;align-items:center;gap:10px;padding:9px 8px 9px 12px;border-radius:16px;background:var(--field);border:1.5px solid var(--line);cursor:pointer;flex:none;transition:transform .2s,box-shadow .2s,border-color .2s;animation:itemIn .4s ease both}
.acc:hover{border-color:var(--g1);box-shadow:0 8px 20px var(--sh);transform:translateY(-1px)}
.acc:active{transform:scale(.99)}
.acc.now{border-color:var(--g1);box-shadow:0 0 0 3px rgba(167,139,250,.16)}
.acc .av{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-weight:900;font-size:14px;color:#fff;background:linear-gradient(135deg,var(--g1),var(--g2))}
.acc .who{flex:1;min-width:0}
.acc .em{font-size:13.5px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acc .sub{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acc .sub.warn{color:var(--bad)}
.acc .sub.now{color:var(--ok);font-weight:800}
.acc .pts b{font-size:18px}
.acc .x{flex:none;width:30px;height:30px;padding:0;border:0;border-radius:9px;background:transparent;color:var(--muted);font-size:18px;line-height:1;cursor:pointer;transition:background .2s,color .2s}
.acc .x:hover,.acc .x:focus-visible{background:rgba(212,80,106,.14);color:var(--bad);outline:none}
.none{padding:14px 6px;font-size:13px;color:var(--muted);text-align:center}
.add{flex:none;display:flex;flex-direction:column;align-items:center;gap:4px;padding:14px;border:2px dashed rgba(167,139,250,.6);border-radius:18px;background:linear-gradient(135deg,rgba(167,139,250,.1),rgba(255,158,199,.12));color:var(--ink);font:inherit;cursor:pointer;transition:transform .2s,box-shadow .2s,background .2s}
.add:hover{transform:translateY(-2px);box-shadow:0 12px 26px var(--sh)}
.add:active{transform:scale(.98)}
.add svg{width:28px;height:28px;stroke:url(#gr);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.add b{font-size:14.5px}.add small{font-size:12px;color:var(--muted)}
/* 进度与日志 */
.logbox{flex:1;min-height:150px;display:flex;flex-direction:column;overflow:hidden;border-radius:18px;background:var(--glass);border:1.5px solid var(--line)}
.live{flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;padding:9px 12px;border-bottom:1px solid var(--line);background:linear-gradient(90deg,rgba(167,139,250,.2),rgba(231,166,210,.26));font-size:13px;font-weight:650;animation:slide .25s ease both}
.live.hidden{display:none}
.spin{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid var(--line);border-top-color:var(--g2);animation:spin .8s linear infinite}
#liveText{display:grid;flex:1;min-width:0;overflow:hidden}
#liveText span{grid-area:1/1;overflow-wrap:anywhere;line-height:1.5}
#liveText .out{animation:rollOut .35s cubic-bezier(.4,0,.2,1) forwards}
#liveText .in{animation:rollIn .35s cubic-bezier(.4,0,.2,1) both}
.lbar{flex-basis:100%;height:4px;border-radius:9px;background:rgba(255,255,255,.5);overflow:hidden}
.lbar div{position:relative;overflow:hidden;height:100%;width:0;border-radius:9px;background:linear-gradient(90deg,var(--g1),var(--g2),#ffb86b,var(--g1));background-size:200% 100%;transition:width .4s ease;animation:flow 2s linear infinite}
.lbar div::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:shine 1.4s linear infinite}
.live.ok{background:rgba(76,185,138,.16);color:var(--ok)}
.live.err{background:rgba(212,80,106,.14);color:var(--bad)}
.live.ok .spin,.live.err .spin{display:none}
.live.ok .lbar div{background:linear-gradient(90deg,#4cb98a,#8fe0b9);animation:none}
.live.err .lbar div{background:var(--bad);animation:none}
.live.ok .lbar div::after,.live.err .lbar div::after{display:none}
.log{flex:1;min-height:0;overflow:auto;padding:8px 10px;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.log .idle{height:100%;min-height:90px;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--muted);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",system-ui,sans-serif;font-size:13px}
.ln{padding:1px 6px;border-left:3px solid transparent;border-radius:4px;white-space:pre-wrap;word-break:break-word}
.ln .t{margin-right:8px;color:var(--muted)}
.ln.fx{animation:fade .4s ease both}
.ln.ok{color:var(--ok);border-left-color:var(--ok);font-weight:700}
.ln.warn{color:var(--bad);border-left-color:var(--bad)}
/* 弹窗（照 Zip2GitHub 的弹出卡片） */
.mask{position:fixed;inset:0;z-index:50;display:flex;overflow:auto;padding:38px 20px 20px;background:rgba(59,51,85,.22);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);opacity:0;visibility:hidden;transition:opacity .28s ease,visibility 0s linear .28s}
.mask.show{opacity:1;visibility:visible;transition:opacity .3s ease}
.card{position:relative;width:100%;max-width:360px;margin:auto;overflow:visible;padding:34px 20px 18px;border-radius:24px;background:var(--bg2);border:1.5px solid var(--line);box-shadow:0 24px 60px rgba(124,92,219,.3);opacity:0;transform:translateY(26px) scale(.94);transition:transform .22s cubic-bezier(.4,0,1,1),opacity .2s ease}
.mask.show .card{opacity:1;transform:none;transition:transform .55s cubic-bezier(.34,1.5,.5,1),opacity .25s ease}
.card .badge{position:absolute;left:50%;top:-22px;width:46px;height:46px;border-radius:15px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,var(--g1),var(--g2));box-shadow:0 10px 22px rgba(150,110,230,.45);transform:translateX(-50%);animation:floaty 4s ease-in-out infinite}
.card .badge svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.card h2{margin:0 0 12px;text-align:center;font-size:16px;color:var(--ink2)}
.card .close{position:absolute;right:10px;top:10px;width:28px;height:28px;border:0;border-radius:50%;background:rgba(167,139,250,.16);color:var(--muted);font-size:17px;cursor:pointer}
.fld{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
.fld label{font-size:12.5px;font-weight:800;color:var(--ink2)}
input{width:100%;height:46px;padding:0 16px;font:inherit;font-size:15px;color:var(--ink);background:var(--field);border:1.5px solid var(--line);border-radius:14px;outline:none;transition:border-color .2s,box-shadow .2s}
input::placeholder{color:var(--muted);opacity:.7}
input:focus-visible{border-color:var(--g1);box-shadow:0 0 0 3px rgba(167,139,250,.2)}
input.shake{animation:shake .4s ease;border-color:var(--bad)}
.btns{display:flex;gap:8px}
.go{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;gap:8px;flex:1;min-height:46px;padding:0 18px;font:inherit;font-size:15px;font-weight:800;color:#fff;border:0;border-radius:14px;cursor:pointer;background:linear-gradient(110deg,#9b7df0,#e7a6d2,#ffa56b,#9b7df0);background-size:250% 100%;box-shadow:0 8px 20px rgba(150,110,230,.32);animation:flow 6s ease-in-out infinite alternate,glow 3s ease-in-out infinite;transition:transform .15s,opacity .2s;touch-action:manipulation}
.go:not(:disabled)::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.35) 50%,transparent 70%);transform:translateX(-100%);animation:shine 3s ease-in-out infinite}
.go>*{position:relative;z-index:1}
.go:disabled{opacity:.55}
.go.alt{flex:none;color:var(--ink);background:var(--field);border:1.5px solid var(--line);box-shadow:none;animation:none}
.go.alt::after{display:none}
.go.wide{width:100%;flex:none}
.hint{margin:6px 4px 0;font-size:12px;line-height:1.6;color:var(--muted)}
.split{height:1px;margin:14px 0 4px;background:var(--line)}
.shotmask{background:rgba(20,10,40,.7)}
.shotmask{align-items:center;justify-content:center}.shotmask img{margin:auto;max-width:94vw;max-height:88dvh;border-radius:14px;border:1.5px solid var(--line);background:var(--field);transform:scale(.94);transition:transform .45s cubic-bezier(.34,1.4,.5,1)}
.shotmask.show img{transform:none}
#setLine{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@keyframes rise{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}
@keyframes paneIn{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}
@keyframes itemIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:none}}
@keyframes floaty{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes drift{0%,100%{transform:translate(0,0)}50%{transform:translate(26px,-20px)}}
@keyframes twinkle{0%,100%{opacity:.15;transform:scale(.8) rotate(0)}50%{opacity:.7;transform:scale(1.15) rotate(18deg)}}
@keyframes glow{0%,100%{box-shadow:0 8px 20px rgba(150,110,230,.32)}50%{box-shadow:0 8px 28px rgba(231,150,200,.55)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{50%{opacity:.3}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes slide{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@keyframes pop{from{opacity:0;transform:translateY(-6px) scale(.98)}to{opacity:1;transform:none}}
@keyframes selPop{0%{transform:scale(.95)}55%{transform:scale(1.04)}100%{transform:scale(1)}}
@keyframes shake{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
@keyframes flow{from{background-position:0 50%}to{background-position:200% 50%}}
@keyframes shine{0%{transform:translateX(-100%)}55%,100%{transform:translateX(100%)}}
@keyframes rollOut{to{transform:translateY(-100%);opacity:0}}
@keyframes rollIn{from{transform:translateY(100%);opacity:0}to{transform:none;opacity:1}}
@media (min-width:860px){
  .app{padding:calc(16px + env(safe-area-inset-top)) 24px 18px}
  .tabs{display:none}
  .work{flex-direction:row;gap:16px}
  .pane{display:flex;flex:1;animation:none}
  .pane.show{animation:none}
  #paneRun{order:2}#paneAcc{order:1}
  .cur:hover,.pane .blk:hover .logbox{transform:translateY(-2px)}
  .accs{max-height:50vh}
}
@media (max-height:560px){.hero .sub{display:none}.logo{width:36px;height:36px}.pane>.blk:first-child{position:relative;z-index:30}
.blk.grow{min-height:100px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}#liveText .out{display:none}}
</style></head><body>
<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="gr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#e8629a"/></linearGradient></defs></svg>
<div class="bg"><i></i><i></i><s style="left:8%;top:22%"></s><s style="left:86%;top:46%;animation-delay:-1.4s"></s><s style="left:30%;top:80%;animation-delay:-2.6s"></s><s style="left:64%;top:12%;animation-delay:-.8s"></s></div>
<div class="app">
<nav class="tabs" id="tabs"><span class="ind" id="ind"></span><button type="button" class="on" data-tab="run">出图</button><button type="button" data-tab="acc">账号<em id="accCount">0</em></button></nav>
<header class="hero">
<div class="logo">Px</div>
<div class="ttl-area"><h1><b>PixAI 反代</b></h1><div class="sub"><span class="pill" id="state"><span class="dot"></span><span id="stateText">空闲</span></span><span id="setLine"></span></div></div>
<div class="tools">
<button class="ib" id="refresh" title="刷新" aria-label="刷新"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg></button>
<button class="ib" id="shot" title="页面截图" aria-label="页面截图"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="12" cy="12" r="3.5"/></svg></button>
<button class="ib" id="keyBtn" title="反代密钥" aria-label="反代密钥"><svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L21 2M16 7l3 3"/></svg></button>
</div>
</header>
<main class="work">
<section class="pane show" id="paneRun">
<div class="blk"><div class="chip"><span><svg viewBox="0 0 24 24"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/></svg></span>当前账号</div>
<div class="curwrap"><div class="cur">
<div class="top">
<div class="who"><small>● 正在使用</small><div class="em" id="curEm">—</div></div>
<div class="pts"><b id="bal">—</b><small>积分 · 单次 <span id="cost">—</span></small></div>
</div>
<div class="acts">
<button class="mini act" id="checkin" type="button"><svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M8 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4-5a2.5 2.5 0 0 1 0 5"/></svg>签到</button>
<button class="mini act" id="retry" type="button"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>重试</button>
<button class="mini stop" id="stop" type="button"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>停止</button>
</div>
<button class="mini swc" id="fold" type="button" aria-expanded="false"><span id="foldText">切换账号</span><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
</div>
<div class="accs" id="accs" hidden></div></div></div>
<div class="blk mdl" id="mdlBox" hidden>
<div class="chip"><span><svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg></span>模型</div>
<div class="mdlcur"><small>当前</small><b id="mdlCur">—</b><em id="mdlSub"></em></div>
<div class="acts" id="mdlBtns"></div>
</div>
<div class="blk grow"><div class="chip"><span><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 10l3 2-3 2M13 15h4"/></svg></span>进度与日志</div>
<div class="logbox">
<div class="live hidden" id="liveLine"><span class="spin"></span><span id="liveText"></span><div class="lbar"><div id="liveBar"></div></div></div>
<div class="log" id="log"><div class="idle">准备就绪，在「账号」里添加或切换账号</div></div>
</div></div>
</section>
<section class="pane" id="paneAcc">
<div class="blk"><div class="chip"><span><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/></svg></span>账号列表</div>
<div class="list" id="accAll"></div></div>
<div class="blk"><button class="add" id="addBtn" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><b>添加 / 重新登录</b><small>邮箱密码，或存下网页上已登录的推特等账号</small></button></div>
</section>
</main>
</div>

<div class="mask" id="loginMask"><div class="card" role="dialog" aria-label="添加账号">
<div class="badge"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/></svg></div><button class="close" id="loginClose" type="button" aria-label="关闭">×</button>
<h2>添加 / 重新登录</h2>
<div class="fld"><label for="email">PixAI 邮箱</label><input id="email" autocomplete="off" inputmode="email" placeholder="name@example.com"></div>
<div class="fld"><label for="password">PixAI 密码</label><input id="password" type="password" autocomplete="off" placeholder="密码只发给反代登录用"></div>
<div class="btns">
<button class="go act" id="login" type="button"><svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg><span id="goText">登录并切换</span></button>
<button class="go alt act" id="loginOnly" type="button">仅登录</button>
</div>
<p class="hint">仅登录：就在当前窗口登录并存档，不回生图页、不重选模型比例</p>
<div class="split"></div>
<button class="go alt wide act" id="saveCur" type="button">保存当前网页登录（推特等第三方登录）</button>
<p class="hint">推特、谷歌这类第三方登录，先在远程浏览器（6080）里的 PixAI 页面登好，再点这个：把当前登录的账号存进列表，以后点一下就能切。</p>
</div></div>
<div class="mask" id="pop"><div class="card" role="dialog" aria-label="反代密钥">
<div class="badge"><svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L21 2M16 7l3 3"/></svg></div>
<h2>反代密钥</h2>
<div class="fld"><label for="token">BRIDGE_TOKEN</label><input id="token" type="password" autocomplete="off" placeholder="BRIDGE_TOKEN"></div>
<div class="btns"><button class="go" id="save" type="button">保存</button></div>
<p class="hint">仅保存在本机浏览器</p>
</div></div>
<div class="mask shotmask" id="modal"><img id="img" alt="页面截图"></div>

<script>

const $ = id => document.getElementById(id);
const store = { get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
const fmt = n => (typeof n === 'number' && isFinite(n)) ? n.toLocaleString('en-US') : '—';
const call = (path, init) => fetch(path, Object.assign({}, init, { headers: { 'Authorization': 'Bearer ' + $('token').value.trim(), 'Content-Type': 'application/json' } }));
const openKey = on => { $('pop').classList.toggle('show', on); if (on) setTimeout(() => $('token').focus(), 280); };
const openLogin = on => { $('loginMask').classList.toggle('show', on); if (on) setTimeout(() => ($('email').value ? $('password') : $('email')).focus(), 300); };
const narrow = () => window.matchMedia('(max-width:859px)').matches;
let tab = 'run';
function showTab(t) {
  tab = t;
  $('paneRun').classList.toggle('show', t === 'run'); $('paneAcc').classList.toggle('show', t === 'acc');
  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), b => b.classList.toggle('on', b.dataset.tab === t));
  $('ind').style.transform = t === 'acc' ? 'translateX(100%)' : 'none';
}
Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), b => { b.onclick = () => showTab(b.dataset.tab); });
$('addBtn').onclick = () => openLogin(true);
$('loginClose').onclick = () => openLogin(false);
$('loginMask').onclick = e => { if (e.target === $('loginMask')) openLogin(false); };
$('pop').onclick = e => { if (e.target === $('pop')) openKey(false); };
function tween(el, to) {
  const from = Number(String(el.textContent).replace(/,/g, '')); if (!isFinite(from) || !isFinite(to) || from === to || window.matchMedia('(prefers-reduced-motion:reduce)').matches) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  (function step(now) { const k = Math.min(1, (now - t0) / 600), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(step); })(t0);
}

// 日志：一行一行淡入，成功绿、失败红
function addLine(text, kind) {
  const l = $('log'), idle = l.querySelector('.idle'); if (idle) idle.remove();
  const near = l.scrollHeight - l.scrollTop - l.clientHeight < 60;
  const d = document.createElement('div'), t = document.createElement('span');
  d.className = 'ln fx' + (kind ? ' ' + kind : '');
  t.className = 't'; t.textContent = new Date().toTimeString().slice(0, 8);
  d.appendChild(t); d.appendChild(document.createTextNode(text));
  l.appendChild(d);
  while (l.children.length > 200) l.removeChild(l.firstChild);
  if (near) l.scrollTop = l.scrollHeight;
}
const say = (text, kind) => addLine(text, kind === 'bad' ? 'warn' : kind);

// 进度行：转圈 + 文字向上滚动替换 + 进度条；结束后定格成绿/红
let liveKey = '';
function setLive(t, p, st) {
  const el = $('liveLine'), box = $('liveText');
  el.classList.toggle('ok', st === 'ok'); el.classList.toggle('err', st === 'err');
  if (!t) { el.classList.add('hidden'); liveKey = ''; box.textContent = ''; return; }
  const wasHidden = el.classList.contains('hidden');
  el.classList.remove('hidden');
  if (p != null) $('liveBar').style.width = p + '%';
  const key = t.replace(/[0-9]+/g, '#'), last = box.lastElementChild;
  if (!last || wasHidden || key === liveKey) {
    if (last) last.textContent = t; else { const s = document.createElement('span'); s.textContent = t; box.appendChild(s); }
    liveKey = key; return;
  }
  Array.prototype.forEach.call(box.querySelectorAll('.out'), x => x.remove());
  last.className = 'out';
  const n = document.createElement('span'); n.className = 'in'; n.textContent = t; box.appendChild(n);
  setTimeout(() => last.remove(), 380);
  liveKey = key;
}

$('token').value = store.get('pixai_admin_token');
if (!$('token').value) { openKey(true); say('先填反代密钥'); }

let setting = '';
const ago = ts => {
  if (!ts) return '未记录';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
};
let accList = [], curEmail = '', foldOpen = false;
function setFold(on) {
  foldOpen = on;
  $('accs').hidden = !on; $('fold').classList.toggle('open', on); $('fold').setAttribute('aria-expanded', on ? 'true' : 'false');
}
$('fold').onclick = ev => { ev.stopPropagation(); setFold(!foldOpen); };
document.addEventListener('click', ev => { if (foldOpen && !ev.target.closest('#accs') && !ev.target.closest('#fold')) setFold(false); });
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && foldOpen) setFold(false); });
function accRow(a, isCur, delay) {
  const needPwd = !a.saved || a.expired;
  const row = document.createElement('div'); row.className = 'acc' + (isCur ? ' now' : ''); row.style.animationDelay = delay + 's';
  const av = document.createElement('div'); av.className = 'av'; av.textContent = String(a.label || a.email).replace(/^id:/, '').charAt(0).toUpperCase() || '?';
  const who = document.createElement('div'); who.className = 'who';
  const em = document.createElement('div'); em.className = 'em'; em.textContent = a.label || a.email; em.title = a.label || a.email;
  const sub = document.createElement('div'); sub.className = 'sub' + (isCur ? ' now' : needPwd ? ' warn' : '');
  const third = String(a.email).indexOf('id:') === 0;
  sub.textContent = isCur ? '● 正在使用' : a.expired ? (third ? '登录已过期，要重新登录并保存' : '登录已过期，点我重新登录') : !a.saved ? '未存档，点我用密码登录' : '点击切换';
  who.appendChild(em); who.appendChild(sub);
  const pts = document.createElement('div'); pts.className = 'pts';
  const b = document.createElement('b'); b.textContent = a.balance == null ? '—' : fmt(a.balance);
  const sm = document.createElement('small'); sm.textContent = a.balance == null ? '积分未记录' : '积分 · ' + ago(a.balanceAt);
  pts.appendChild(b); pts.appendChild(sm);
  row.appendChild(av); row.appendChild(who); row.appendChild(pts);
  if (!isCur) {
    const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '×'; x.title = '删除记录'; x.setAttribute('aria-label', '删除 ' + (a.label || a.email));
    x.onclick = ev => { ev.stopPropagation(); forget(a); };
    row.appendChild(x);
  }
  row.onclick = () => { setFold(false); pick(a, isCur, needPwd); };
  return row;
}
function renderAccs(info) {
  const box = $('accs'), all = $('accAll'), cur = String((info && info.current) || '').toLowerCase();
  curEmail = (info && info.current) || '';
  accList = (info && info.list) || [];
  const curAcc = accList.find(a => a.email.toLowerCase() === cur), curName = curAcc ? (curAcc.label || curAcc.email) : curEmail;
  $('curEm').textContent = curName || '未记录账号';
  $('curEm').title = curName;
  const others = accList.filter(a => a.email.toLowerCase() !== cur);
  $('foldText').textContent = '切换账号 (' + others.length + ')';
  $('accCount').textContent = accList.length;
  box.textContent = ''; all.textContent = '';
  if (!others.length) { const d = document.createElement('div'); d.className = 'none'; d.textContent = '没有其他账号，到「账号」里添加'; box.appendChild(d); }
  others.forEach((a, i) => box.appendChild(accRow(a, false, i * 0.04)));
  if (!accList.length) { const d = document.createElement('div'); d.className = 'none'; d.textContent = '还没有账号，点下面的按钮添加'; all.appendChild(d); return; }
  const sorted = (curAcc ? [curAcc] : []).concat(others);
  sorted.forEach((a, i) => all.appendChild(accRow(a, a === curAcc, i * 0.05)));
}
let modelBusy = false;
function renderModels(j) {
  const list = (j && j.models) || [];
  $('mdlBox').hidden = !list.length;
  if (!list.length) return;
  const cur = j.model || {};
  $('mdlCur').textContent = cur.name || '读不到网页上的模型';
  $('mdlSub').textContent = [].concat((cur.recipes || []).map(x => 'Recipe ' + x), (cur.loras || []).map(x => 'LoRA ' + x)).join(' · ');
  const box = $('mdlBtns');
  box.textContent = '';
  list.forEach(m => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'mini' + (cur.id === m.id ? ' on' : ''); b.textContent = m.name; b.disabled = modelBusy;
    b.onclick = () => pickModel(m);
    box.appendChild(b);
  });
}
async function pickModel(m) {
  if (modelBusy) return;
  modelBusy = true; setActs(true);
  document.querySelectorAll('#mdlBtns button').forEach(b => { b.disabled = true; });
  say('正在切换模型：' + m.name + '（要十几秒到半分钟）', 'ok');
  try {
    const r = await call('/admin/model', { method: 'POST', body: JSON.stringify({ model: m.id }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) say('模型已切换：' + m.name, 'ok'); else say(j.message || ('切换失败（' + r.status + '）'), 'bad');
  } catch (e) { say('切换失败：' + e.message, 'bad'); }
  modelBusy = false; setActs(false);
  refresh(true);
}
function show(j) {
  if (j && typeof j.balance === 'number') tween($('bal'), j.balance); else $('bal').textContent = '—';
  $('cost').textContent = fmt(j && j.cost);
  const parts = [];
  if (j && j.ratio) parts.push('比例 ' + j.ratio);
  if (j && j.size) parts.push(j.size);
  if (j && j.count) parts.push('一次 ' + j.count + ' 张');
  setting = parts.join(' · ');
  $('setLine').textContent = setting;
  renderModels(j);
  if (j && j.accounts) renderAccs(j.accounts);
  const gen = !!(j && j.generating), stuck = !!(j && j.stuck);
  $('state').className = 'pill' + (stuck ? ' stuck' : gen ? ' on' : '');
  $('stateText').textContent = stuck ? '疑似卡住，点重试' : gen ? '正在出图' : '空闲';
}

let busy = false;
async function refresh(quiet, deep) {
  if (!$('token').value.trim()) { if (!quiet) { openKey(true); say('先填反代密钥', 'bad'); } return; }
  try {
    const r = await (deep ? call('/admin/refresh', { method: 'POST', body: '{}' }) : call('/admin/state')); const j = await r.json().catch(() => ({}));
    if (r.status === 401) { $('keyBtn').classList.add('warn'); if (!quiet) { say('密钥不对', 'bad'); openKey(true); } return; }
    if (r.status === 403) { say(j.message || '没有权限', 'bad'); return; }
    $('keyBtn').classList.remove('warn');
    store.set('pixai_admin_token', $('token').value.trim());
    if (!r.ok) { if (!quiet) say((j.message || '读取失败') + '（' + r.status + '）', 'bad'); return; }
    show(j);
    if (!quiet) say('已刷新' + (j.message ? ' · ' + j.message : '') + (setting ? ' · 网页当前：' + setting : ''), 'ok');
  } catch (e) { if (!quiet) say('读取失败：' + e.message, 'bad'); }
}
$('refresh').onclick = async () => { const b = $('refresh'); b.classList.add('spin'); await refresh(false, true); setTimeout(() => b.classList.remove('spin'), 300); };
$('keyBtn').onclick = () => openKey(true);
$('save').onclick = () => { openKey(false); refresh(false); };
$('token').onkeydown = e => { if (e.key === 'Enter') $('save').onclick(); };
$('password').onkeydown = e => { if (e.key === 'Enter') doLogin(false); };
$('email').onkeydown = e => { if (e.key === 'Enter') $('password').focus(); };

const closeShot = () => { $('modal').classList.remove('show'); const u = $('img').src; if (u) setTimeout(() => { URL.revokeObjectURL(u); $('img').removeAttribute('src'); }, 320); };
$('modal').onclick = closeShot;
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeShot(); openKey(false); openLogin(false); } });
$('shot').onclick = async () => {
  say('正在截图…');
  try {
    const r = await call('/admin/screenshot');
    if (!r.ok) { const j = await r.json().catch(() => ({})); return say((j.message || '截图失败') + '（' + r.status + '）', 'bad'); }
    $('img').src = URL.createObjectURL(await r.blob()); $('modal').classList.add('show'); say('截图已打开，点空白处关闭');
  } catch (e) { say('截图失败：' + e.message, 'bad'); }
};

// 登录期间每 0.6 秒问一次反代「做到哪一步了」
let lastStage = '', lastPct = 0;
async function poll() {
  try {
    const r = await call('/admin/progress'); if (!r.ok) return;
    const j = await r.json();
    if (j.state === 'run' && j.text && j.text !== lastStage) { lastStage = j.text; lastPct = j.pct || lastPct; setLive(j.text, lastPct); addLine(j.text); }
  } catch (e) {}
}
const setActs = off => document.querySelectorAll('.act').forEach(b => { b.disabled = off; });
async function runJob(url, body, startText, firstLine) {
  if (busy) return false;
  busy = true; setActs(true);
  lastStage = ''; lastPct = 3; setLive(startText, 3); addLine(firstLine);
  const timer = setInterval(poll, 600);
  let ok = false;
  try {
    const r = await call(url, { method: 'POST', body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      ok = true; const m = j.message || '完成';
      setLive(m, 100, 'ok');
      if (j.warn) say(m); else say('✓ ' + m, 'ok');
    } else { const m = (j.message || '失败') + '（' + r.status + '）'; setLive('✕ ' + m, lastPct, 'err'); say(m, 'bad'); }
  } catch (e) { setLive('✕ 失败：' + e.message, lastPct, 'err'); say('失败：' + e.message, 'bad'); }
  finally { clearInterval(timer); busy = false; setActs(false); }
  await refresh(true);
  return ok;
}
async function doLogin(keep) {
  if (busy) return;
  const email = $('email').value.trim();
  if (!email || !$('password').value) { const f = !email ? $('email') : $('password'); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake'); f.focus(); return say('邮箱和密码都要填', 'bad'); }
  openLogin(false); if (narrow()) showTab('run');
  const btn = keep ? $('loginOnly') : $('goText'), old = btn.textContent;
  btn.textContent = '登录中…';
  const ok = await runJob('/admin/login', { email: email, password: $('password').value, keep: keep }, keep ? '正在登录（仅添加）…' : '正在登录…', (keep ? '仅登录 ' : '开始登录 ') + email);
  if (ok) $('password').value = '';
  btn.textContent = old;
}
$('login').onclick = () => doLogin(false);
$('loginOnly').onclick = () => doLogin(true);
$('saveCur').onclick = async () => {
  openLogin(false); if (narrow()) showTab('run');
  setActs(true); say('正在读取网页上当前登录的账号…', 'ok');
  try {
    const r = await call('/admin/save-current', { method: 'POST', body: '{}' });
    const j = await r.json().catch(() => ({}));
    say(j.message || (r.ok ? '已保存' : '保存失败（' + r.status + '）'), r.ok ? 'ok' : 'bad');
  } catch (e) { say('保存失败：' + e.message, 'bad'); }
  setActs(false); refresh(true);
};
$('checkin').onclick = () => runJob('/admin/checkin', {}, '正在签到…', '签到：只处理当前页面上的每日领取弹窗');
$('stop').onclick = async () => {
  try {
    const r = await call('/admin/stop', { method: 'POST', body: '{}' });
    const j = await r.json().catch(() => ({}));
    if (r.ok) say(j.message || '已发出停止'); else say((j.message || '停止失败') + '（' + r.status + '）', 'bad');
  } catch (e) { say('停止失败：' + e.message, 'bad'); }
  refresh(true);
};
$('retry').onclick = () => runJob('/admin/retry', {}, '正在重试…', '重试：放弃卡住的任务，重新打开生图页');
function pick(a, isCur, needPwd) {
  if (busy) return;
  if (isCur) return say('已经是 ' + (a.label || a.email));
  if (needPwd && String(a.email).indexOf('id:') === 0) { openLogin(true); return say('这个账号要先在远程浏览器（6080）里重新登录，再点「保存当前网页登录」'); }
  if (needPwd) { $('email').value = a.email; openLogin(true); return say((a.expired ? '登录状态过期了' : '这个账号还没存档') + '，填密码登录一次'); }
  { if (narrow()) showTab('run'); runJob('/admin/switch', { email: a.email }, '正在切换…', '切换到 ' + (a.label || a.email)); }
}
async function forget(a) {
  if (busy) return;
  if (!confirm('删除 ' + (a.label || a.email) + ' 的记录和登录存档？')) return;
  try {
    const r = await call('/admin/forget', { method: 'POST', body: JSON.stringify({ email: a.email }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { say('已删除 ' + (a.label || a.email)); await refresh(true); } else say((j.message || '删除失败') + '（' + r.status + '）', 'bad');
  } catch (e) { say('删除失败：' + e.message, 'bad'); }
}
refresh(true);
setInterval(() => { if (!document.hidden && !busy) refresh(true); }, 30000);
</script></body></html>`;

// ───────────── 账号记录：邮箱 + 最后一次读到的积分 + 登录状态存档（用来秒切）─────────────
// 存档文件等同于账号登录凭证，别放进 git / 公开目录。容器重建会丢，想长期保留就把 ACCOUNT_DIR 指到挂载卷里。
const ACCOUNT_DIR = env('ACCOUNT_DIR', path.join(process.cwd(), 'accounts'));
const INDEX_FILE = path.join(ACCOUNT_DIR, 'index.json');
const OLD_ACCOUNT_FILE = env('ACCOUNT_FILE', path.join(os.tmpdir(), 'pixai-bridge-account.json'));
let accounts = { current: '', list: [] }; // list 项：{ email, balance, balanceAt, savedAt, expired }，不记密码
const sameEmail = (x, y) => String(x).toLowerCase() === String(y).toLowerCase();
const findAcc = email => accounts.list.find(a => sameEmail(a.email, email));
const accFile = email => path.join(ACCOUNT_DIR, createHash('sha1').update(String(email).toLowerCase()).digest('hex').slice(0, 16) + '.json');
let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      await fs.mkdir(ACCOUNT_DIR, { recursive: true, mode: 0o700 });
      await fs.writeFile(INDEX_FILE, JSON.stringify(accounts), { mode: 0o600 });
    } catch (error) { console.error('保存账号记录失败：', error.message); }
  }, 300);
}
// ───────────── 分辨率对照表（API 模式用）─────────────
// API 模式下插件按「比例 + 尺寸档位」选分辨率，但 API 要的是具体的宽×高。这张表从网页上读一次（逐个比例点过去，读每个档位的宽×高），
// 存在 ACCOUNT_DIR/resolutions.json 里，之后 API 模式不再碰网页。账号有会员时多出来的档位，重新读一次就有了。
const RES_FILE = path.join(ACCOUNT_DIR, 'resolutions.json');
let resTable = null; // { at, ratios: { '9:16': [{ size, width, height, locked }] } }
async function captureResolutions(page) {
  await openSettingsTab(page);
  const before = (await readPageStatus(page)).resolution;
  const names = (before.ratios || []).map(item => item.ratio);
  if (!names.length) throw new Error('网页上没读到比例按钮（要先打开生图页的「設定」标签）');
  const ratios = {};
  for (const ratio of names) {
    if (!(await setRatio(page, ratio))) { console.warn(`读分辨率表：比例 ${ratio} 没切过去，跳过`); continue; }
    await sleep(500);
    const now = (await readPageStatus(page)).resolution;
    const list = (now.sizes || []).filter(item => Number.isInteger(item.width) && Number.isInteger(item.height)).map(item => ({ size: item.size, width: item.width, height: item.height, locked: !!item.locked }));
    if (list.length) ratios[ratio] = list;
  }
  // 还原网页上原来选的比例和尺寸
  if (before.ratio) await setRatio(page, before.ratio).catch(() => {});
  if (before.size) await setSize(page, before.size).catch(() => {});
  if (!Object.keys(ratios).length) throw new Error('一个比例的尺寸档位都没读到');
  resTable = { at: new Date().toISOString(), ratios };
  await fs.mkdir(ACCOUNT_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(RES_FILE, JSON.stringify(resTable), { mode: 0o600 });
  console.log(`已读出分辨率表：${Object.entries(ratios).map(([k, v]) => `${k}（${v.map(x => x.size).join('/')}）`).join('，')}`);
  return resTable;
}
fs.readFile(RES_FILE, 'utf8').then(text => { const v = json(text, null); if (v && v.ratios) resTable = v; }).catch(() => {});
// 只读：每条记录里有哪些参数（长文字只给开头），用来核对记录里还有没有别的提示词。
app.get('/ai/template/keys', (_req, res) => {
  const show = v => typeof v === 'string' ? (v.length > 40 ? v.slice(0, 40) + '…(' + v.length + '字)' : v) : Array.isArray(v) ? `[${v.length} 项]` : v && typeof v === 'object' ? `{${Object.keys(v).join(',')}}` : v;
  res.json(tpls.map(rec => ({ id: rec.id, top: Object.keys(rec.body), parameters: Object.fromEntries(Object.entries(rec.body.parameters).map(([k, v]) => [k, show(v)])) })));
});
/** 记录网页设置，反代自己点网页的「生成」（和直控出图同一个按钮）：先拦住，再点，请求被拦下来就记下了，不会真提交。点不成就保持等待，用户可以自己在网页上点。 */
async function recordTemplateByClick(page) {
  const before = tpls.length ? tpls[tpls.length - 1].id : '';
  await armTemplate(page);
  const note = [];
  try {
    await dismissDailyReward(page);
    await dismissPopups(page).catch(() => {});
    const editor = page.locator('div[contenteditable="true"].tiptap.ProseMirror');
    await editor.waitFor({ state: 'visible', timeout: 15000 });
    const text = (await editor.innerText().catch(() => '')).trim();
    if (!text) await fillPrompt(page, editor, 'a'); // 输入框是空的按钮点不了；占位的字不会被记下来（提示词一律不存）
    const button = page.locator('section.group\\/prompt-box button[data-react-aria-pressable="true"]').first();
    await button.waitFor({ state: 'visible', timeout: 15000 });
    if (await button.isDisabled()) throw new Error('网页上的「生成」按钮现在点不了');
    await button.click();
  } catch (error) {
    note.push(error.message);
  }
  for (let i = 0; i < 20 && armed && (tpls[tpls.length - 1]?.id || '') === before; i++) await sleep(500);
  const got = (tpls[tpls.length - 1]?.id || '') !== before;
  if (!got) { console.warn('反代自己点「生成」没记下设置：' + (note[0] || '请求没被拦到')); await disarmTemplate(); } // 不再留着拦截：否则之后在网页上点「生成」会被无声截掉
  return { got, message: got ? '' : note[0] || '没拦到网页的请求' };
}
app.post('/ai/template', async (req, res) => {
  const action = req.body?.action;
  try {
    if (action === 'arm') {
      if (isGenerating()) return res.status(409).json({ ok: false, message: '反代正在出图，画完再记' });
      await armTemplate(await getPixAIPage());
    } else if (action === 'record') {
      if (isGenerating()) return res.status(409).json({ ok: false, message: '反代正在出图，画完再记' });
      const job = settingLock.then(async () => recordTemplateByClick(await getPixAIPage()));
      settingLock = holdLock(job);
      let result;
      try { result = await job; } catch (error) { await disarmTemplate(); throw error; }
      return res.json({ ok: true, recorded: result.got, message: result.message, template: templateState() });
    } else if (action === 'cancel') await disarmTemplate();
    else if (action === 'delete') {
      const id = String(req.body?.id || '');
      tpls = tpls.filter(item => item.id !== id);
      if (tplCurrent === id) tplCurrent = tpls[tpls.length - 1]?.id || '';
      await saveTemplates();
    } else if (action === 'clear') { await disarmTemplate(); tpls = []; tplCurrent = ''; await saveTemplates(); }
    else return res.status(400).json({ ok: false, message: 'action 要是 arm / record / cancel / delete / clear' });
    res.json({ ok: true, template: templateState() });
  } catch (error) { res.status(502).json({ ok: false, message: error.message }); }
});
app.post('/ai/resolutions', async (_req, res) => {
  if (isGenerating()) return res.status(409).json({ ok: false, generating: true, message: '反代正在出图，画完再读' });
  const job = settingLock.then(async () => captureResolutions(await getPixAIPage()));
  settingLock = holdLock(job);
  try { res.json({ ok: true, resolutions: (await job).ratios, at: resTable.at }); }
  catch (error) { res.status(502).json({ ok: false, message: error.message }); }
});

(async () => {
  const v = json(await fs.readFile(INDEX_FILE, 'utf8').catch(() => ''), null);
  if (v && Array.isArray(v.list)) {
    accounts = {
      current: String(v.current || ''),
      list: v.list.filter(a => a && a.email).map(a => ({
        email: String(a.email), balance: Number.isFinite(a.balance) ? a.balance : null,
        balanceAt: Number(a.balanceAt) || 0, savedAt: Number(a.savedAt) || 0, expired: !!a.expired
      }))
    };
    return;
  }
  const old = json(await fs.readFile(OLD_ACCOUNT_FILE, 'utf8').catch(() => ''), null); // 迁移旧版「只记邮箱」的文件
  if (old && old.email) accounts = { current: String(old.email), list: [{ email: String(old.email), balance: null, balanceAt: 0, savedAt: 0, expired: false }] };
})();
const publicAccounts = () => ({
  current: accounts.current,
  list: accounts.list.map(a => ({ email: a.email, label: a.label || a.email, balance: a.balance, balanceAt: a.balanceAt, saved: !!a.savedAt, expired: a.expired }))
});
// 每次读到积分，就记到「当前账号」名下：切走之后，这里留的就是它最后的剩余积分
function noteBalance(balance) {
  if (!accounts.current || !Number.isFinite(balance)) return;
  const a = findAcc(accounts.current);
  if (!a) return;
  const changed = a.balance !== balance;
  a.balance = balance; a.balanceAt = Date.now();
  if (changed) persist();
}
async function recordCurrentBalance() { // 换账号之前，先把当前账号最后的积分记下来
  try {
    const ctx = (await connectBrowser()).contexts()[0];
    const page = ctx.pages().find(p => p.url().includes('/generator/image'));
    if (page) noteBalance((await readPageStatus(page)).balance);
    persist();
  } catch { /* 读不到就用上一次记的 */ }
}
async function saveLoginState(email) {
  const ctx = (await connectBrowser()).contexts()[0];
  const state = await ctx.storageState();
  await fs.mkdir(ACCOUNT_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(accFile(email), JSON.stringify(state), { mode: 0o600 });
}

app.get('/admin', (_req, res) => res.type('html').send(ADMIN_HTML));

app.use('/admin', (req, res, next) => {
  if (!CONFIG.token) return res.status(403).json({ message: '换账号需要先设置环境变量 BRIDGE_TOKEN，否则任何人都能换你的账号' });
  next();
});

const adminState = async page => {
  const status = await readPageStatus(page);
  noteBalance(status.balance);
  return {
    ok: true, loggedIn: page.url().includes('/generator/image'), accounts: publicAccounts(), page: page.url(), generating, stuck: generating && !isGenerating(),
    ratio: status.resolution.ratio, size: status.resolution.label, count: status.count, balance: status.balance, cost: status.cost,
    models: status.models, model: status.model
  };
};
app.get('/admin/state', async (_req, res) => {
  try { res.json(await adminState(await getPixAIPage())); }
  catch (error) { res.status(503).json({ ok: false, message: error.message }); }
});

// 顶部「刷新」：除了读页面上的积分和设置，还问 PixAI 现在登录的是谁，把「当前账号」对上，并记下它的积分
app.post('/admin/refresh', async (_req, res) => {
  try {
    const page = await getPixAIPage();
    let note = '';
    if (generating) note = '正在出图，只刷新了积分和设置';
    else {
      watchApiHeaders(page);
      for (let i = 0; i < 20 && !apiReady(); i++) await sleep(500);
      const me = await apiCall(page, 'GET', '/v2/user/me').catch(() => null);
      const user = me && me.status === 200 && me.json?.id ? me.json : null;
      if (!user) note = '读不到网页上登录的账号（可能还没登录），只刷新了积分和设置';
      else {
        const source = String(user.verificationSource || 'email').toLowerCase();
        const acc = accounts.list.find(a => a.uid && a.uid === String(user.id))
          || findAcc('id:' + user.id)
          || (source === 'email' && user.email ? findAcc(user.email) : null);
        const who = String(user.email || '').trim() || '@' + (user.username || user.id);
        if (acc) {
          if (!acc.uid) acc.uid = String(user.id);
          if (accounts.current !== acc.email) { accounts.current = acc.email; acc.expired = false; }
          persist();
          note = '当前账号：' + (acc.label || acc.email);
        } else note = '网页上登录的是 ' + who + '，还没存进列表，到「账号」里点「保存当前网页登录」';
      }
    }
    const state = await adminState(page);
    res.json({ ...state, message: note });
  } catch (error) {
    res.status(503).json({ ok: false, message: error.message });
  }
});

// 管理页切模型：和 POST /ai/settings 里的 model 是同一套动作（同样排队、出图时不让切）
app.post('/admin/model', async (req, res) => {
  const id = String((req.body || {}).model || '').trim();
  if (!MODEL_PRESETS.some(item => item.id === id)) return res.status(400).json({ ok: false, message: '没有这个模型预设' });
  if (isGenerating()) return res.status(409).json({ ok: false, message: '反代正在出图，画完再切' });
  const job = settingLock.then(async () => { const page = await getPixAIPage(); await chooseModelPreset(page, id); });
  settingLock = holdLock(job);
  try { await job; res.json({ ok: true }); }
  catch (error) { console.warn('管理页切换模型失败：', error.message); res.status(502).json({ ok: false, message: '没能切换模型：' + error.message }); }
});

app.get('/admin/screenshot', async (_req, res) => {
  try {
    const ctx = (await connectBrowser()).contexts()[0];
    const page = ctx.pages().find(p => p.url().includes('pixai.art')) ?? ctx.pages()[0];
    if (!page) return res.status(404).json({ message: '浏览器里没有打开的页面' });
    res.type('png').send(await page.screenshot({ type: 'png' }));
  } catch (error) {
    res.status(503).json({ message: error.message });
  }
});

// 换账号进度：页面每 0.6 秒来问一次（GET /admin/progress），显示「正在做什么」
let loginProgress = { text: '', pct: 0, state: 'idle', at: 0 };
let stopRequested = false, adminJobs = 0; // 「停止」按钮：下一次 stage() 时让正在跑的管理任务停下
const stage = (text, pct, state = 'run') => {
  if (state === 'run' && stopRequested) { stopRequested = false; throw new Error('已手动停止'); }
  loginProgress = { text, pct, state, at: Date.now() };
};
app.get('/admin/progress', (_req, res) => res.json(loginProgress));

/** 在 page 上走一遍邮箱密码登录（打开登录页 → 填写 → 提交 → 等密码框消失）。不碰生图页，换账号和「仅登录」共用。 */
async function loginInPage(page, email, password) {
  stage('打开登录页', 30);
  await safeGoto(page, CONFIG.loginUrl);
  const passwordBox = page.locator('input[type="password"]:visible').first();
  const emailButton = page.getByText(/使用\s*Email\s*(繼續|继续)|Continue with Email/i).first();
  // 登录页：Google / Discord / Twitter / Apple 下面有「使用 Email 繼續」，点开才出现 電子郵件 + 密碼 表单
  if (!(await passwordBox.isVisible().catch(() => false))) {
    if (!(await emailButton.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false))) {
      // 没直接出登录框：去点页面上的「登入 / 登录」
      await page.getByText(/^\s*(登入|登录|Log\s*in|Sign\s*in)\s*$/i).first().click({ timeout: 8000 }).catch(() => {});
      await emailButton.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    }
    if (await emailButton.isVisible().catch(() => false)) await emailButton.click();
  }
  await passwordBox.waitFor({ state: 'visible', timeout: 15000 });
  const emailBox = page.locator('input[type="email"]:visible, input[placeholder*="電子郵件"]:visible, input[placeholder*="电子邮件"]:visible, input[placeholder*="mail" i]:visible, input[type="text"]:visible').first();
  stage('填写邮箱和密码', 60);
  await emailBox.fill(email);
  await passwordBox.fill(password);
  const submit = page.getByRole('button', { name: /^\s*(繼續|继续|Continue)\s*$/ }).first();
  if (await submit.count()) await submit.click(); else await passwordBox.press('Enter');

  stage('提交登录，等待结果', 75);
  const left = await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 40000 }).then(() => true, () => false);
  if (!left) throw new Error('登录没成功：密码框还在（可能密码不对，或出现了验证码/二次验证）。点「当前页面截图」看一下');

}

async function switchAccount(email, password) {
  live.headers = null;
  stage('记录当前账号的积分', 5);
  await recordCurrentBalance();
  const ctx = (await connectBrowser()).contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('pixai.art')) ?? await ctx.newPage();

  // 清掉旧账号的登录状态（cookie + 本地存储）
  stage('清除旧账号的登录状态', 15);
  await ctx.clearCookies();
  await page.goto('https://pixai.art/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } }).catch(() => {});

  await loginInPage(page, email, password);

  // 登录后回到生图页，重新选好模型、比例
  stage('回到生图页，选择模型和比例', 88);
  await (opening ??= openGeneratorPage().finally(() => { opening = null; }));
  batcher.runs.clear(); // 旧账号时缓存的批次作废
}

// 统计正在跑的管理任务（登录 / 切换 / 签到 / 重试），给「停止」用
app.use(['/admin/login', '/admin/switch', '/admin/checkin', '/admin/retry'], (_req, res, next) => {
  adminJobs++; stopRequested = false;
  let done = false;
  const end = () => { if (!done) { done = true; adminJobs--; } };
  res.on('finish', end); res.on('close', end);
  next();
});

// 保存当前网页的登录状态：账号名读 /v2/user/me（邮箱登录的用邮箱；推特等没有邮箱的用「用户名 (来源)」）
app.post('/admin/save-current', async (req, res) => {
  try {
    const page = await getPixAIPage();
    watchApiHeaders(page);
    for (let i = 0; i < 30 && !apiReady(); i++) await sleep(500);
    const me = await apiCall(page, 'GET', '/v2/user/me');
    if (me.status !== 200 || !me.json?.id) return res.status(502).json({ ok: false, message: `读不到当前登录的账号（${me.status}），网页上是不是还没登录？` });
    const user = me.json;
    // 账号按 PixAI 的用户 ID 区分：推特登录和邮箱密码登录，哪怕邮箱一样，也是两个独立账号。
    const source = String(user.verificationSource || 'email').toLowerCase();
    const sourceName = { email: '邮箱', twitter: '推特', x: '推特', google: '谷歌', discord: 'Discord', apple: 'Apple', facebook: 'Facebook' }[source] || source;
    const who = String(user.email || '').trim() || `@${user.username || user.id}`;
    const name = `${who} · ${sourceName}`;
    // 邮箱密码登录的账号，如果已经按邮箱存过，就沿用那条记录，不重复
    const key = source === 'email' && user.email && findAcc(user.email) ? user.email : `id:${user.id}`;
    let acc = findAcc(key);
    if (!acc) { acc = { email: key, balance: null, balanceAt: 0, savedAt: 0, expired: false }; accounts.list.push(acc); }
    acc.label = name; acc.uid = String(user.id);
    accounts.current = acc.email; acc.expired = false;
    try { noteBalance((await readPageStatus(page)).balance); } catch { /* 之后轮询会补上 */ }
    await saveLoginState(acc.email); acc.savedAt = Date.now();
    persist();
    console.log(`已保存当前网页登录：${name}`);
    res.json({ ok: true, message: `已保存 ${name} 的登录状态，现在用的就是这个账号（账号按 PixAI 用户 ID 区分，和同邮箱的其他登录方式互不影响）` });
  } catch (error) {
    console.error('保存当前登录失败：', error.message);
    res.status(502).json({ ok: false, message: error.message });
  }
});

app.post('/admin/login', async (req, res) => {
  const email = String(req.body?.email || '').trim(), password = String(req.body?.password || ''), keep = !!req.body?.keep;
  if (!email || !password) return res.status(400).json({ message: '邮箱和密码都要填' });
  if (isGenerating()) return res.status(409).json({ message: '反代正在出图，画完再换账号（卡住了就点「重试」）' });
  // 「仅登录」：就在当前窗口登录并存档（不新开临时环境）。和「登录并切换」的区别：登录完不回生图页、不重新选模型比例，要出图时再自己打开。
  if (keep) {
    const job = settingLock.then(async () => {
      live.headers = null;
      stage('记录当前账号的积分', 5);
      await recordCurrentBalance();
      const ctx = (await connectBrowser()).contexts()[0];
      const page = ctx.pages().find(p => p.url().includes('pixai.art')) ?? await ctx.newPage();
      stage('清除旧账号的登录状态', 15);
      await ctx.clearCookies();
      await safeGoto(page, 'https://pixai.art/').catch(() => {});
      await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } }).catch(() => {});
      await loginInPage(page, email, password);
      stage('保存登录状态', 92);
      await saveLoginState(email);
      batcher.runs.clear(); // 旧账号时缓存的批次作废
    });
    settingLock = holdLock(job);
    try {
      await job;
      let acc = findAcc(email);
      if (!acc) { acc = { email, balance: null, balanceAt: 0, savedAt: 0, expired: false }; accounts.list.push(acc); }
      acc.expired = false; acc.savedAt = Date.now(); accounts.current = acc.email;
      persist();
      const message = '已在当前窗口登录并存档 ' + acc.email + '（没有回生图页，要出图时会自动打开）';
      stage(message, 100, 'ok');
      console.log('已登录并存档 PixAI 账号（仅登录，当前窗口）');
      return res.json({ ok: true, message });
    } catch (error) {
      stage('登录失败', loginProgress.pct, 'err');
      console.error('仅登录失败：', error.message); // 不记录密码
      return res.status(502).json({ ok: false, message: error.message });
    }
  }
  const job = settingLock.then(() => switchAccount(email, password));
  settingLock = holdLock(job);
  try {
    await job;
    let acc = findAcc(email);
    if (!acc) { acc = { email, balance: null, balanceAt: 0, savedAt: 0, expired: false }; accounts.list.push(acc); }
    accounts.current = acc.email; acc.expired = false;
    stage('保存登录状态，下次点一下就能切', 95);
    try { noteBalance((await readPageStatus(await getPixAIPage())).balance); } catch { /* 之后轮询会补上 */ }
    try { await saveLoginState(acc.email); acc.savedAt = Date.now(); } catch (error) { console.error('保存登录状态失败：', error.message); }
    persist();
    const message = '已登录并回到生图页';
    stage(message, 100, 'ok');
    console.log('已切换 PixAI 账号');
    res.json({ ok: true, message });
  } catch (error) {
    stage('登录失败', loginProgress.pct, 'err');
    console.error('换账号失败：', error.message); // 不记录密码
    res.status(502).json({ ok: false, message: error.message });
  }
});

async function switchToSaved(email) {
  live.headers = null; // 换账号后旧令牌作废，等页面发出新账号的请求再抄
  const state = json(await fs.readFile(accFile(email), 'utf8').catch(() => ''), null);
  if (!state) throw new Error('这个账号还没有存档，请用邮箱密码登录一次');
  stage('记录当前账号的积分', 8);
  await recordCurrentBalance();
  const ctx = (await connectBrowser()).contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('pixai.art')) ?? await ctx.newPage();

  stage('清除当前登录', 25);
  await ctx.clearCookies();
  await page.goto('https://pixai.art/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } }).catch(() => {});

  stage('载入这个账号的登录状态', 45);
  if (Array.isArray(state.cookies) && state.cookies.length) await ctx.addCookies(state.cookies);
  for (const o of state.origins || []) {
    if (!/pixai/i.test(o.origin) || !o.localStorage?.length) continue;
    await page.goto(o.origin, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.evaluate(items => { for (const i of items) { try { localStorage.setItem(i.name, i.value); } catch { /* ignore */ } } }, o.localStorage).catch(() => {});
  }

  stage('打开生图页，选择模型和比例', 70);
  try {
    await (opening ??= openGeneratorPage().finally(() => { opening = null; }));
  } catch (error) {
    if (error.login) {
      const a = findAcc(email);
      if (a) { a.expired = true; persist(); }
      throw new Error('这个账号的登录状态过期了，请用密码登录一次');
    }
    throw error;
  }
  batcher.runs.clear();
}

app.post('/admin/switch', async (req, res) => {
  const email = String(req.body?.email || '').trim(), acc = findAcc(email);
  if (!acc) return res.status(404).json({ message: '没有这个账号的记录' });
  if (!acc.savedAt) return res.status(400).json({ message: '这个账号还没存档，请用密码登录一次' });
  if (sameEmail(accounts.current, acc.email)) return res.json({ ok: true, message: '已经是这个账号' });
  if (isGenerating()) return res.status(409).json({ message: '反代正在出图，画完再换账号（卡住了就点「重试」）' });
  const job = settingLock.then(() => switchToSaved(acc.email));
  settingLock = holdLock(job);
  try {
    await job;
    accounts.current = acc.email; acc.expired = false;
    try { noteBalance((await readPageStatus(await getPixAIPage())).balance); } catch { /* 之后轮询会补上 */ }
    persist();
    stage('已切换并回到生图页', 100, 'ok');
    console.log('已切换到存档账号');
    res.json({ ok: true, message: '已切换到 ' + acc.email });
  } catch (error) {
    stage('切换失败', loginProgress.pct, 'err');
    console.error('切换账号失败：', error.message);
    res.status(502).json({ ok: false, message: error.message });
  }
});

app.post('/admin/forget', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!findAcc(email)) return res.status(404).json({ message: '没有这个账号的记录' });
  accounts.list = accounts.list.filter(a => !sameEmail(a.email, email));
  if (sameEmail(accounts.current, email)) accounts.current = '';
  await fs.rm(accFile(email), { force: true }).catch(() => {});
  persist();
  res.json({ ok: true });
});

// 重试：出图卡死 / 账号在后端退出后页面没反应时用。放弃卡住的任务，关掉旧页面，重新打开生图页。不走 settingLock（它可能就是卡在那里）
async function resetGeneration() {
  stage('放弃卡住的任务', 10);
  genEpoch++; generating = false; genStart = 0; opening = null;
  settingLock = Promise.resolve();
  batcher.runs.clear();
  const ctx = (await connectBrowser()).contexts()[0];
  stage('关闭卡住的页面', 30);
  const old = ctx.pages().filter(p => p.url().includes('pixai.art'));
  await ctx.newPage(); // 先开个空白页，免得关掉最后一个标签后浏览器退出；openGeneratorPage 会优先复用它
  for (const p of old) await p.close({ runBeforeUnload: false }).catch(() => {});
  stage('重新打开生图页，选择模型和比例', 55);
  await (opening ??= openGeneratorPage().finally(() => { opening = null; }));
  batcher.runs.clear();
}

app.post('/admin/retry', async (_req, res) => {
  try {
    await resetGeneration();
    try { noteBalance((await readPageStatus(await getPixAIPage())).balance); } catch { /* 之后轮询会补上 */ }
    stage('已重置，生图页重新打开', 100, 'ok');
    res.json({ ok: true, message: '已重置卡住的任务，生图页重新打开' });
  } catch (error) {
    stage('重试失败', loginProgress.pct, 'err');
    console.error('重试失败：', error.message);
    res.status(502).json({ ok: false, message: error.login ? '页面回到了登录页：账号已退出，请重新登录' : error.message });
  }
});

// 签到：只处理「当前已经打开的生图页」上的「每日領取」弹窗，不刷新、不重新打开页面。页面上没有弹窗就直接告诉你
app.post('/admin/checkin', async (_req, res) => {
  if (isGenerating()) return res.status(409).json({ message: '反代正在出图，画完再签到（卡住了就点「重试」）' });
  const job = settingLock.then(async () => {
    const ctx = (await connectBrowser()).contexts()[0];
    const page = ctx.pages().find(p => p.url().includes('/generator/image'));
    if (!page) throw new Error('没有打开的生图页，先点「重试」打开页面');
    stage('检查有没有每日领取弹窗', 10);
    // 每次都重新定位弹窗和按钮（不拿旧节点）；弹窗没了就算签完；失败了清掉挡路的提示弹窗，隔一会儿再来
    const titleNow = () => page.getByText(/^\s*每日(領取|领取)\s*$/).first();
    let seen = false, before = null, still = true, claimed = false;
    for (let i = 1; i <= RETRY.tries; i++) {
      await dismissPopups(page).catch(() => {});
      if (!(await titleNow().isVisible().catch(() => false))) { still = false; break; }
      seen = true;
      if (before === null) before = (await readPageStatus(page)).balance;
      stage(`处理每日领取弹窗（第 ${i}/${RETRY.tries} 次：勾验证、点领取）`, 30 + i * 15);
      await dismissDailyReward(page);
      if (dailyClaimed) { claimed = true; still = false; break; }
      if (!(await titleNow().isVisible().catch(() => false))) { still = false; break; }
      console.warn(`签到第 ${i}/${RETRY.tries} 次弹窗还在`);
      if (i < RETRY.tries) await sleep(RETRY.gap);
    }
    if (!seen) return { popup: false };
    stage('读取签到后的积分', 85);
    const after = (await readPageStatus(page)).balance;
    return { popup: true, before, after, still, claimed };
  });
  settingLock = holdLock(job);
  try {
    const r = await job;
    if (!r.popup) {
      stage('没有签到弹窗', 100, 'ok');
      return res.json({ ok: true, warn: true, message: '当前页面没有签到弹窗：今天已领过，或这个页面没弹出（签到不会刷新页面）' });
    }
    noteBalance(r.after);
    const gain = Number.isFinite(r.before) && Number.isFinite(r.after) ? r.after - r.before : null;
    if (r.claimed) { stage('签到成功', 100, 'ok'); return res.json({ ok: true, message: '签到成功（弹窗显示「獎勵已領取」）' + (gain > 0 ? '，+' + gain.toLocaleString('en-US') + ' 积分，现在 ' + r.after.toLocaleString('en-US') : '') }); }
    if (gain > 0) { stage('签到成功', 100, 'ok'); return res.json({ ok: true, message: '签到成功，+' + gain.toLocaleString('en-US') + ' 积分，现在 ' + r.after.toLocaleString('en-US') }); }
    stage('签到结束', 100, 'ok');
    res.json({ ok: true, warn: true, message: r.still ? '验证没通过，弹窗还在：用 6080 端口的浏览器手动点一次' : '弹窗关了，但积分没变化' });
  } catch (error) {
    stage('签到失败', loginProgress.pct, 'err');
    console.error('签到失败：', error.message);
    res.status(502).json({ ok: false, message: error.message });
  }
});

// 停止：正在跑的管理任务在下一步停下；卡住的出图任务直接放弃（不关页面、不重新打开）
app.post('/admin/stop', (_req, res) => {
  const running = adminJobs > 0, gen = generating;
  if (!running && !gen) return res.json({ ok: true, message: '现在没有在运行的任务' });
  const parts = [];
  if (running) { stopRequested = true; parts.push('已发出停止，当前这一步做完就会停下（最长几十秒）'); }
  if (gen) {
    genEpoch++; generating = false; genStart = 0;
    settingLock = Promise.resolve();
    batcher.runs.clear();
    parts.push('已放弃出图任务（页面里那张可能还在画）');
  }
  console.log('收到停止：' + parts.join('；'));
  res.json({ ok: true, message: parts.join('；') });
});

// 调试（只读，不点任何按钮）：导出模型 / LoRA / Recipe 相关元素的 HTML，用来校准选择器。
// 先在网页上手动打开要看的面板（模型列表 / LoRA 面板 / Recipe 面板），再在 VPS 上：
//   curl -s -H "Authorization: Bearer 你的密钥" http://127.0.0.1:3188/debug/model
app.get('/debug/model', async (_req, res) => {
  try {
    const page = await getPixAIPage();
    const dom = await page.evaluate(() => {
      const visible = el => !!(el.offsetWidth || el.offsetHeight);
      const cut = (el, n) => el
        ? el.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/<img[^>]*>/g, '<img/>').replace(/\s+/g, ' ').slice(0, n)
        : null;
      const up = (el, n) => { for (let i = 0; i < n && el?.parentElement; i++) el = el.parentElement; return el; };
      const clickable = Array.from(document.querySelectorAll('button, [role="button"], a')).filter(visible);
      const lora = clickable.find(el => /^LoRA/.test((el.innerText || '').trim()));
      const editor = document.querySelector('div[contenteditable="true"].tiptap.ProseMirror');
      const panels = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]')).filter(visible);
      return {
        editor: cut(up(editor, 1), 6000),
        bar: cut(up(lora, 3), 8000),
        tiptap: !!editor?.editor, // 编辑器对象是否挂在元素上（只检查，不使用）
        controls: clickable.slice(0, 80).map(el => el.tagName.toLowerCase() + (el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : '') + ' | ' + (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30) + ' | ' + (el.getAttribute('aria-label') || '')),
        panels: panels.map(el => cut(el, 12000))
      };
    });
    const out = [
      '=== 输入框（含 LoRA 芯片）===', dom.editor || '(没找到)',
      '=== 底部那排：模型 / LoRA / Recipe 按钮 ===', dom.bar || '(没找到)',
      '=== 编辑器对象可用：' + dom.tiptap + ' ===',
      '=== 页面上能点的东西（类型 | 文字 | aria-label）===', ...dom.controls,
      '=== 当前打开的面板 / 列表（' + dom.panels.length + ' 个）===', ...dom.panels.map((p, i) => '--- 第 ' + (i + 1) + ' 个 ---\n' + p)
    ].join('\n');
    res.type('text/plain; charset=utf-8').send(out);
  } catch (error) {
    res.status(503).json({ message: error.message });
  }
});

// 只读：把页面上「每日領取」签到弹窗的真实结构原样倒出来（弹窗 HTML、可见按钮、iframe 和 frame 列表），给签到功能对着真实元素改。不点任何东西。
app.get('/debug/checkin', async (_req, res) => {
  try {
    const ctx = (await connectBrowser()).contexts()[0];
    const pages = ctx.pages().map(p => p.url());
    const page = ctx.pages().find(p => p.url().includes('/generator/image')) || ctx.pages()[0];
    if (!page) return res.status(503).json({ message: '没有打开的页面' });
    const dom = await page.evaluate(() => {
      const visible = el => !!(el.offsetWidth || el.offsetHeight);
      const clean = (el, n) => el ? el.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/<img[^>]*>/g, '<img/>').replace(/\s+/g, ' ').slice(0, n) : null;
      const title = Array.from(document.querySelectorAll('*')).find(el => el.children.length === 0 && /^\s*每日(領取|领取)\s*$/.test(el.textContent || ''));
      let box = title;
      for (let i = 0; i < 8 && box?.parentElement; i++) { box = box.parentElement; if (box.matches('[role="dialog"], dialog, [data-state="open"]')) break; }
      const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      return {
        titleFound: !!title,
        dialog: clean(box, 6000),
        buttons: Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible).map(el => ({ text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40), disabled: el.disabled || el.getAttribute('aria-disabled') === 'true', rect: rect(el) })).filter(x => /領取|领取|獎勵|奖励|驗證|验证|關閉|关闭|close/i.test(x.text)),
        iframes: Array.from(document.querySelectorAll('iframe')).map(el => ({ src: (el.getAttribute('src') || '').slice(0, 160), title: el.title, visible: visible(el), rect: rect(el) })),
        humanText: Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0 && /驗證您是人類|验证您是人类|Verify you are human/.test(el.textContent || '')).map(el => ({ tag: el.tagName, text: el.textContent.trim().slice(0, 40), rect: rect(el), parent: clean(el.parentElement, 400) }))
      };
    });
    const frames = [];
    for (const fr of page.frames()) {
      const el = await fr.frameElement().catch(() => null);
      frames.push({ url: fr.url().slice(0, 160), rect: el ? await el.boundingBox().catch(() => null) : null });
    }
    res.json({ pages, page: page.url(), ...dom, frames });
  } catch (error) {
    res.status(503).json({ message: error.message });
  }
});

app.get('/debug/dom', async (_req, res) => {
  try {
    const page = await getPixAIPage();
    const dom = await page.evaluate(() => {
      const visible = el => !!(el.offsetWidth || el.offsetHeight);
      const cut = (el, n) => el
        ? el.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/<img[^>]*>/g, '<img/>').replace(/\s+/g, ' ').slice(0, n)
        : null;
      const up = (el, n) => { for (let i = 0; i < n && el?.parentElement; i++) el = el.parentElement; return el; };
      const topup = Array.from(document.querySelectorAll('button')).find(el => /^(儲值|储值|充值)$/.test((el.innerText || '').trim()));
      const radio = Array.from(document.querySelectorAll('[role="radio"]')).find(visible);
      return {
        header: cut(up(topup, 3), 3000),
        promptBox: cut(document.querySelector('section.group\\/prompt-box'), 5000),
        settings: cut(up(radio, 5), 9000)
      };
    });
    res.json(dom);
  } catch (error) {
    res.status(503).json({ message: error.message });
  }
});

/** bridge_batch: {run, index, size}，格式不对就当没带。 */
function readHint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const run = typeof raw.run === 'string' ? raw.run.slice(0, 80) : '';
  const index = Number(raw.index), size = Number(raw.size);
  if (!run || !Number.isInteger(index) || !Number.isInteger(size) || index < 0 || size < 1 || size > 64 || index >= size) return null;
  return { run, index, size, recover: raw.recover === true };
}

/** 插件在 parameters.bridge_mode 里说的出图方式：{mode: 'api', model, loraWeight} 或 {mode: 'direct'}；宽高取请求本身的 width / height。 */
function readSpec(raw, params) {
  if (!raw || typeof raw !== 'object' || !['api', 'direct'].includes(raw.mode)) return null;
  if (raw.mode === 'direct') return { mode: 'direct' };
  const dim = v => (Number.isInteger(v) && v >= 64 && v <= 8192 ? v : null);
  return { mode: 'api', source: raw.source === 'page' ? 'page' : 'preset', useLora: raw.useLora !== false, useRecipe: raw.useRecipe !== false, template: typeof raw.template === 'string' ? raw.template.slice(0, 40) : '', loraTweaks: Object.fromEntries(Object.entries(raw.loraTweaks && typeof raw.loraTweaks === 'object' ? raw.loraTweaks : {}).slice(0, 20).filter(([k, v]) => /^\d{1,30}$/.test(k) && v && typeof v === 'object').map(([k, v]) => [k, { on: v.on !== false, weight: Number.isFinite(v.weight) ? Math.min(1, Math.max(0, v.weight)) : null }])), model: typeof raw.model === 'string' ? raw.model.slice(0, 40) : '', loraWeight: Number.isFinite(raw.loraWeight) ? raw.loraWeight : null, width: dim(params.width), height: dim(params.height) };
}

app.post('/ai/generate-image', async (req, res) => {
  const body = req.body;
  const params = body?.parameters || {};

  if (!body || (body.action && body.action !== 'generate')) {
    return res.status(400).json({ message: '仅支持 NovelAI 文生图请求' });
  }

  const prompt = typeof body.input === 'string' && body.input.trim()
    ? body.input.trim()
    : typeof params.prompt === 'string' ? params.prompt.trim() : '';

  if (!prompt) {
    return res.status(400).json({ message: '缺少提示词：请提供 input' });
  }

  // 图生图 / 局部重绘走 action，上面已拒绝；Vibe、角色参考 PixAI 用不上，忽略而不是报错，免得整次出图失败
  const ignored = ['img2img', 'image', 'mask', 'reference_image', 'reference_image_multiple', 'director_reference_images']
    .filter(name => params[name] && (!Array.isArray(params[name]) || params[name].length));
  if (ignored.length) console.log(`忽略 PixAI 不支持的参数：${ignored.join(', ')}`);

  const hint = readHint(params.bridge_batch), spec = readSpec(params.bridge_mode, params);

  // 客户端中途取消（还没排到就断开）就不再去 PixAI 出图，省额度
  let gone = false;
  res.on('close', () => { if (!res.writableEnded) gone = true; });

  // 出图慢时请求会一直挂着没有数据：等超过 keepAliveStartMs 还没结果，就先发响应头（201 + zip），再周期性写空格字节保活，
  // 图好了把 ZIP 接在后面。很快就能回答的情况（410 已过期、参数错误等）不受影响，仍然返回正常的状态码。
  let pad = 0, started = false, timer = null;
  const beat = () => { if (!res.writableEnded && !res.destroyed) { res.write(' '); pad++; } };
  const startTimer = setTimeout(() => {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.status(201);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="pixai-image.zip"');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    started = true;
    beat();
    timer = setInterval(beat, CONFIG.keepAliveMs);
  }, CONFIG.keepAliveStartMs);
  const stopBeat = () => { clearTimeout(startTimer); clearInterval(timer); };
  res.on('close', stopBeat);

  const processRequest = async () => {
    if (gone) {
      console.log('请求已被取消，跳过');
      return;
    }
    try {
      const { file, index, size, taskId } = await batcher.take(prompt, hint, spec);

      stopBeat(); // 之后不会再写保活字节，pad 就是最终的前导字节数
      const zip = makeZip([{
        name: `image_${index + 1}${path.extname(file.name) || '.png'}`,
        data: file.data
      }], pad);

      if (started) {
        res.end(zip);
      } else {
        res.status(201);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="pixai-image.zip"');
        res.send(zip);
      }

      console.log(`任务 ${taskId}：已返回第 ${index + 1}/${size} 张${hint ? '' : '（旧插件，按提示词归批）'}`);
    } catch (error) {
      stopBeat();
      // 响应头已经先发出去了（保活中）：状态码改不了，只能直接结束；酒馆会因为内容无法识别而失败，之后点重试会用 recover 取回，不会重画
      if (res.headersSent) {
        console.error('保活期间出图失败（响应头已发出，无法改状态码）：', error?.code === 'EXPIRED' ? error.message : error);
        if (!res.writableEnded) res.end(` PixAI 生成失败：${error?.message || ''}`);
        return;
      }
      if (error?.code === 'EXPIRED') {
        console.log('重新获取：这张图已不在反代里（超过时限或反代重启过），没有重画');
        if (!res.headersSent) res.status(410).json({ message: error.message, expired: true });
        return;
      }
      console.error('生成失败：', error);
      if (!res.headersSent) {
        res.status(500).json({ message: error.message || 'PixAI 生成失败' });
      }
    }
  };

  // 串行排队，绝不因正在生成而返回 409
  const queued = requestQueue.then(processRequest, processRequest);
  requestQueue = queued.catch(error => {
    console.error('请求队列错误：', error);
  });

  await queued;
});

let requestQueue = Promise.resolve();

app.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`PixAI Bridge API listening on ${CONFIG.port}`);
});

// 启动后自动打开生图页；浏览器可能还没起来，所以重试一阵
(async () => {
  for (let i = 1; i <= 30; i++) {
    try {
      const page = await getPixAIPage();
      console.log(`PixAI 生图页就绪：${page.url()}`);
      return;
    } catch (error) {
      console.log(`等待浏览器/生图页（${i}/30）：${error.message}`);
      if (error.login) return;
      await sleep(5000);
    }
  }
})();
