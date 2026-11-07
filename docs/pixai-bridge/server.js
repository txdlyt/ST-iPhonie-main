import express from 'express';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ───────────── 配置：直接改这里，或用环境变量覆盖 ─────────────
const env = (key, fallback) => process.env[key] ?? fallback;
const json = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const CONFIG = {
  port: Number(env('PORT', 3188)),
  cdp: env('CDP', 'http://127.0.0.1:9222'),
  // 允许跨域的酒馆地址，逗号分隔
  origins: env('ALLOW_ORIGINS', 'https://tavo.thh.kdns.fr').split(',').map(s => s.trim()).filter(Boolean),
  // 填了就要求请求带 Authorization: Bearer <这个值>（插件里「NovelAI 密钥」填同一个值）；留空不校验
  token: env('BRIDGE_TOKEN', ''),
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

// 找不到生图页就自己打开：优先复用空白页 / PixAI 其他页，否则新开标签。登录状态来自浏览器持久化数据，不用重新登录。
async function openGeneratorPage() {
  const ctx = (await connectBrowser()).contexts()[0];
  const pages = ctx.pages();
  const page = pages.find(p => /^(about:blank|chrome:\/\/newtab)/.test(p.url()))
    ?? pages.find(p => p.url().includes('pixai.art'))
    ?? await ctx.newPage();

  console.log(`未找到生图页，正在打开：${CONFIG.pixaiUrl}`);
  await page.goto(CONFIG.pixaiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

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
  await selectModel(page, CONFIG.model).catch(error => console.error('自动选模型失败，请人工检查：', error.message));
  await setRatio(page, CONFIG.ratio).catch(error => console.warn('自动选比例失败：', error.message));
  return page;
}

async function getPixAIPage() {
  if (opening) return await opening;
  const ctx = (await connectBrowser()).contexts()[0];
  const existing = ctx.pages().find(p => p.url().includes('/generator/image'));
  if (existing) return existing;
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
  async take(prompt, hint) {
    this.prune();
    const per = this.counts.at(-1);
    let key, run, index;

    if (hint) {
      key = 'run:' + hint.run;
      run = this.runs.get(key);
      // hint.recover: the plugin lost the answer and only wants this picture again: never draw one for it.
      if (!run || run.prompt !== prompt) {
        if (hint.recover) throw Object.assign(new Error('这张图已不在反代里'), { code: 'EXPIRED' });
        run = { legacy: false, prompt, size: hint.size, groups: new Map(), used: 0, next: 0 };
      }
      run.size = hint.size;
      index = hint.index;
    } else {
      key = 'legacy:' + prompt;
      run = this.runs.get(key) ?? { legacy: true, prompt, size: this.legacySize, groups: new Map(), used: 0, next: 0 };
      index = run.next;
    }
    this.runs.delete(key);
    this.runs.set(key, run);
    run.used = this.now();

    const group = Math.floor(index / per), slot = index % per;
    const want = this.countFor(Math.min(per, Math.max(1, run.size - group * per)));
    let entry = run.groups.get(group);
    if (hint?.recover && (!entry || (entry.result && slot >= entry.result.files.length))) throw Object.assign(new Error('这张图已不在反代里'), { code: 'EXPIRED' });
    if (!entry || (entry.result && slot >= entry.result.files.length)) {
      entry = { result: null, promise: null };
      run.groups.set(group, entry);
      entry.promise = this.generate(prompt, want).then(
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
const COUNT_LABEL = n => (n === 1 ? /單張|单张/ : new RegExp(`x\\s*${n}(?!\\d)`, 'i'));

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
    const m = /x\s*(\d+)/i.exec(label);
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
  if ((await readPageCount(page)) === count) return true;
  const target = page.locator('[role="radio"]').filter({ hasText: COUNT_LABEL(count) }).first();
  if (!(await target.count())) {
    console.warn(`网页上没找到「一次出 ${count} 张」的按钮，没有切换`);
    return false;
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
async function dismissDailyReward(page) {
  try {
    const title = page.getByText(/^\s*每日(領取|领取)\s*$/).first();
    if (!(await title.isVisible().catch(() => false))) return false;
    console.log('检测到「每日領取」弹窗，自动处理…');

    const claim = page.getByRole('button', { name: /領取今日獎勵|领取今日奖励/ }).first();
    const done = page.getByRole('button', { name: /獎勵已領取|奖励已领取|明天見|明天见/ }).first();

    if (await claim.isVisible().catch(() => false)) {
      // Cloudflare 验证框在 iframe 里：直接点它左边的勾选框位置（真实鼠标事件）
      const frame = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
      if (await frame.count()) {
        await frame.scrollIntoViewIfNeeded().catch(() => {});
        const box = await frame.boundingBox();
        if (box) await page.mouse.click(box.x + 30, box.y + box.height / 2);
      } else {
        console.warn('签到弹窗里没找到 Cloudflare 验证 iframe');
      }
      for (let i = 0; i < 40 && !(await claim.isEnabled().catch(() => false)); i++) await sleep(500);
      if (await claim.isEnabled().catch(() => false)) {
        await claim.click({ timeout: 5000 });
        await done.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      } else {
        console.warn('签到验证没通过，「領取今日獎勵」一直点不了；用 6080 端口的浏览器手动点一次');
      }
    }
    if (await done.isVisible().catch(() => false)) await done.click({ timeout: 3000 }).catch(() => {});
    if (await title.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(500);
    }
    if (await title.isVisible().catch(() => false)) await page.mouse.click(5, 5).catch(() => {});
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

let settingLock = Promise.resolve();

async function generateBatch(prompt, count) {
  await settingLock;
  generating = true;
  try {
    const page = await getPixAIPage();
    await dismissDailyReward(page); // 页面刷新过会重新弹签到框，先关掉

    const oldIds = await page.evaluate(selector =>
      Array.from(document.querySelectorAll(selector)).map(card => card.getAttribute('data-task-id')),
      CARD
    );

    const switched = await setQuantity(page, count);
    const needed = switched ? count : CONFIG.pageCount;
    await setRatio(page, CONFIG.ratio).catch(error => console.warn('切换画面比例失败：', error.message));

    const editor = page.locator('div[contenteditable="true"].tiptap.ProseMirror');
    await editor.waitFor({ state: 'visible', timeout: 30000 });
    await editor.fill(prompt);

    const generateButton = page.locator(
      'section.group\\/prompt-box button[data-react-aria-pressable="true"]'
    ).first();

    await generateButton.waitFor({ state: 'visible', timeout: 30000 });
    if (await generateButton.isDisabled()) {
      throw new Error('PixAI 生成按钮当前不可用');
    }
    await generateButton.click();

    const taskHandle = await page.waitForFunction(({ previousIds, card, thumb, min }) => {
      const found = Array.from(document.querySelectorAll(card)).find(item => {
        const id = item.getAttribute('data-task-id');
        return id && !previousIds.includes(id) && item.querySelectorAll(thumb).length >= min;
      });
      return found?.getAttribute('data-task-id') || false;
    }, { previousIds: oldIds, card: CARD, thumb: THUMB, min: needed }, { timeout: 300000 });

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
    generating = false;
  }
}

const batcher = new Batcher({
  generate: generateBatch,
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
      const m = /x\s*(\d+)/i.exec(countLabel);
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

    const out = {
      count,
      countLabel,
      resolution: {
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
  return out;
}

// 给酒馆插件取的参数：GET /ai/status（带密钥时同样要 Authorization）；加 ?debug=1 会多返回原始节点信息，用来校准选择器
app.get('/ai/status', async (req, res) => {
  try {
    const page = await getPixAIPage();
    const status = await readPageStatus(page, req.query.debug === '1');
    res.json({ ok: true, generating, ...status, updatedAt: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ ok: false, message: error.message });
  }
});

// 调试：导出顶栏（积分）、提示词框（生成按钮）、设置区（张数/比例/尺寸）的 HTML，用来校准选择器：curl http://127.0.0.1:3188/debug/dom
// 给酒馆插件切网页参数：POST /ai/settings  {"count": 1 | 4}，把网页「一次出几张」切过去，回的内容和 /ai/status 一样
app.post('/ai/settings', async (req, res) => {
  const count = Number(req.body?.count);
  if (!CONFIG.counts.includes(count)) {
    return res.status(400).json({ ok: false, message: `张数只能是 ${CONFIG.counts.join(' 或 ')}` });
  }
  if (generating) {
    return res.status(409).json({ ok: false, generating: true, message: '反代正在出图，画完再切张数' });
  }
  const run = async () => {
    const page = await getPixAIPage();
    const switched = await setQuantity(page, count);
    const status = await readPageStatus(page);
    return { switched, status };
  };
  const job = settingLock.then(run);
  settingLock = job.catch(() => {});
  try {
    const { switched, status } = await job;
    if (!switched || status.count !== count) {
      return res.status(502).json({ ok: false, generating, ...status, message: '没能在 PixAI 网页上切换张数' });
    }
    res.json({ ok: true, generating, ...status, updatedAt: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ ok: false, message: error.message });
  }
});

// ───────────── 换账号：浏览器打开 /admin（可以给它单独配一个域名），填密钥 + PixAI 邮箱密码，反代清掉旧登录、自动登录新账号 ─────────────
// 必须设置 BRIDGE_TOKEN 才能用（否则任何人都能换你的账号）；密码只经这一次请求送到反代，不落盘、不进日志。请用 HTTPS 域名访问。
const ADMIN_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>PixAI 反代 · 账号</title>
<style>
:root{--gap:10px;--pad:11px;--ink:#5b3fc4;--ink2:#8a78c9;--muted:#8d85a8;--bg1:#e6dcfb;--bg2:#fbeef6;--bg3:#f0ebfd;--card:rgba(255,255,255,.72);--line:#e0d6f8;--field:#fff;--g1:#a78bfa;--g2:#e7a6d2;--bad:#c0475f;--ok:#3d8f7a;--idle:#3d8f7a}
@media (prefers-color-scheme:dark){:root{--ink:#cdbcff;--ink2:#a595de;--muted:#9a93b8;--bg1:#241d3d;--bg2:#2d2140;--bg3:#1f1a33;--card:rgba(255,255,255,.07);--line:#3d3360;--field:#2a2347;--bad:#ff8aa0;--ok:#7fd6bf;--idle:#7fd6bf}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%;margin:0;overflow:hidden}
body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",system-ui,sans-serif;color:var(--ink);background:linear-gradient(165deg,var(--bg1),var(--bg2) 55%,var(--bg3)) fixed}
.app{height:100dvh;max-width:480px;margin:0 auto;display:flex;flex-direction:column;padding:env(safe-area-inset-top) 14px calc(12px + env(safe-area-inset-bottom))}
header{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 2px 8px}
.brand{display:flex;align-items:center;gap:8px;min-width:0}
.brand b{font-size:17px;letter-spacing:.3px;white-space:nowrap}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;color:var(--muted);background:var(--card);border:1px solid var(--line);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--idle)}
.pill.on .dot{background:var(--g1);animation:pulse 1.2s ease-in-out infinite}
.pill.on{color:var(--ink)}
.tools{display:flex;gap:8px}
.ib{display:grid;place-items:center;width:34px;height:34px;padding:0;color:var(--ink);background:var(--field);border:1.5px solid var(--line);border-radius:11px;cursor:pointer}
.ib svg,.go svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.ib:active,.go:active{transform:scale(.96)}
.ib.warn{border-color:var(--bad);color:var(--bad)}
main{flex:1;min-height:0;display:flex;flex-direction:column;gap:var(--gap);overflow:auto}
.stats{flex:none;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.stat{padding:8px 14px;border-radius:16px;background:var(--field);border:1.5px solid var(--line);min-width:0;box-shadow:0 6px 18px rgba(140,110,220,.1)}
.stat.wide{grid-column:span 2}
.stat b{display:block;font-size:11px;font-weight:600;color:var(--muted)}
.stat span{display:block;font-size:22px;font-weight:800;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:linear-gradient(135deg,var(--g1),#d58ac0);-webkit-background-clip:text;background-clip:text;color:transparent}
.stat span.sm{font-size:16px}
.form{flex:none;display:flex;flex-direction:column;gap:8px}
input{width:100%;padding:var(--pad) 16px;font-size:15px;color:var(--ink);background:var(--field);border:1.5px solid var(--line);border-radius:14px;outline:none}
input::placeholder{color:var(--muted);opacity:.7}
input:focus-visible{border-color:var(--g1);box-shadow:0 0 0 3px rgba(167,139,250,.2)}
.go{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:2px;padding:13px;font-size:16px;font-weight:800;color:#fff;border:0;border-radius:999px;cursor:pointer;background:linear-gradient(100deg,var(--g1),var(--g2));box-shadow:0 8px 20px rgba(150,110,230,.32)}
.go:disabled{opacity:.55}
.go:focus-visible,.ib:focus-visible{outline:2px solid var(--g1);outline-offset:2px}
.hint{margin:0 4px;font-size:12px;color:var(--muted)}
.ttl{margin:0 2px 2px;font-size:13px;font-weight:700;color:var(--ink2)}
.logbox{flex:1;min-height:110px;display:flex;flex-direction:column;overflow:hidden;border-radius:18px;background:var(--card);border:1.5px solid var(--line);box-shadow:0 6px 18px rgba(140,110,220,.1);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
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
.live.err{background:rgba(192,71,95,.14);color:var(--bad)}
.live.ok .spin,.live.err .spin{display:none}
.live.ok .lbar div{background:linear-gradient(90deg,#4cb98a,#8fe0b9);animation:none}
.live.err .lbar div{background:var(--bad);animation:none}
.live.ok .lbar div::after,.live.err .lbar div::after{display:none}
.log{flex:1;min-height:0;overflow:auto;padding:8px 10px;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.log .idle{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--muted);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",system-ui,sans-serif;font-size:13px}
.ln{padding:1px 6px;border-left:3px solid transparent;border-radius:4px;white-space:pre-wrap;word-break:break-word}
.ln .t{margin-right:8px;color:var(--muted)}
.ln.fx{animation:fade .4s ease both}
.ln.ok{color:var(--ok);border-left-color:var(--ok);font-weight:700}
.ln.warn{color:var(--bad);border-left-color:var(--bad)}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{50%{opacity:.3}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes slide{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@keyframes flow{from{background-position:0 50%}to{background-position:200% 50%}}
@keyframes shine{0%{transform:translateX(-100%)}55%,100%{transform:translateX(100%)}}
@keyframes rollOut{to{transform:translateY(-100%);opacity:0}}
@keyframes rollIn{from{transform:translateY(100%);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}#liveText .out{display:none}}
.pop,.modal{position:fixed;inset:0;display:none;z-index:10}
.pop.show,.modal.show{display:block}
.mask{position:absolute;inset:0;background:rgba(40,25,80,.35)}
.sheet{position:absolute;top:calc(env(safe-area-inset-top) + 58px);left:14px;right:14px;max-width:452px;margin:0 auto;padding:14px;border-radius:20px;background:var(--bg2);border:1.5px solid var(--line);box-shadow:0 16px 40px rgba(60,40,120,.3);display:flex;flex-direction:column;gap:8px}
.sheet .row{display:flex;gap:8px}
.sheet .row input{flex:1}
.sheet .save{flex:none;padding:0 18px;font-size:14px;font-weight:700;color:#fff;border:0;border-radius:14px;cursor:pointer;background:linear-gradient(100deg,var(--g1),var(--g2))}
.modal .mask{background:rgba(20,10,40,.7)}
.modal img{position:absolute;top:50%;left:50%;max-width:94vw;max-height:88dvh;transform:translate(-50%,-50%);border-radius:14px;border:1.5px solid var(--line);background:var(--field)}
@media (max-height:560px){header{padding:6px 2px 4px}.hint{display:none}.logbox{min-height:84px}}
</style></head><body>
<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="gr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#e7a6d2"/></linearGradient></defs></svg>
<div class="app">
<header>
<div class="brand"><b>PixAI 反代</b><span class="pill" id="state"><span class="dot"></span><span id="stateText">空闲</span></span></div>
<div class="tools">
<button class="ib" id="refresh" title="刷新" aria-label="刷新"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg></button>
<button class="ib" id="shot" title="页面截图" aria-label="页面截图"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="12" cy="12" r="3.5"/></svg></button>
<button class="ib" id="keyBtn" title="反代密钥" aria-label="反代密钥"><svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L21 2M16 7l3 3"/></svg></button>
</div>
</header>
<main>
<div class="stats">
<div class="stat wide"><b>当前账号</b><span class="sm" id="acct">—</span></div>
<div class="stat"><b>剩余积分</b><span id="bal">—</span></div>
<div class="stat"><b>单次消耗</b><span id="cost">—</span></div>
</div>
<div class="form">
<h2 class="ttl">切换账号</h2>
<input id="email" autocomplete="off" inputmode="email" placeholder="PixAI 邮箱">
<input id="password" type="password" autocomplete="off" placeholder="PixAI 密码">
<button class="go" id="login"><svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg><span id="goText">登录并切换</span></button>
<p class="hint">会清掉当前登录，换成新账号；出图时不能切换。</p>
</div>
<div class="logbox">
<div class="live hidden" id="liveLine"><span class="spin"></span><span id="liveText"></span><div class="lbar"><div id="liveBar"></div></div></div>
<div class="log" id="log"><div class="idle">准备就绪，填好账号后点「登录并切换」</div></div>
</div>
</main>
</div>

<div class="pop" id="pop"><div class="mask" id="popMask"></div><div class="sheet">
<h2 class="ttl">反代密钥</h2>
<div class="row"><input id="token" type="password" autocomplete="off" placeholder="BRIDGE_TOKEN"><button class="save" id="save">保存</button></div>
<p class="hint">只保存在这台设备的浏览器里。</p>
</div></div>
<div class="modal" id="modal"><div class="mask" id="modalMask"></div><img id="img" alt="页面截图"></div>

<script>
const $ = id => document.getElementById(id);
const store = { get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
const fmt = n => (typeof n === 'number' && isFinite(n)) ? n.toLocaleString('en-US') : '—';
const call = (path, init) => fetch(path, Object.assign({}, init, { headers: { 'Authorization': 'Bearer ' + $('token').value.trim(), 'Content-Type': 'application/json' } }));
const openKey = on => { $('pop').classList.toggle('show', on); if (on) setTimeout(() => $('token').focus(), 50); };

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
if (!$('token').value) { openKey(true); say('先填反代密钥，才能读取状态'); }

let setting = '';
function show(j) {
  const a = j && j.account;
  $('acct').textContent = a && a.email ? a.email : (j && j.loggedIn === false ? '未登录' : '未记录');
  $('acct').title = a && a.at ? '最近一次用本页切换：' + new Date(a.at).toLocaleString() : '用本页登录过一次后会记住账号';
  $('bal').textContent = fmt(j && j.balance);
  $('cost').textContent = fmt(j && j.cost);
  const parts = [];
  if (j && j.ratio) parts.push('比例 ' + j.ratio);
  if (j && j.size) parts.push(j.size);
  if (j && j.count) parts.push('一次 ' + j.count + ' 张');
  setting = parts.join(' · ');
  $('state').className = 'pill' + (j && j.generating ? ' on' : '');
  $('stateText').textContent = j && j.generating ? '正在出图' : '空闲';
}

let busy = false;
async function refresh(quiet) {
  if (!$('token').value.trim()) { if (!quiet) { openKey(true); say('先填反代密钥', 'bad'); } return; }
  try {
    const r = await call('/admin/state'); const j = await r.json().catch(() => ({}));
    if (r.status === 401) { $('keyBtn').classList.add('warn'); if (!quiet) { say('密钥不对', 'bad'); openKey(true); } return; }
    if (r.status === 403) { say(j.message || '没有权限', 'bad'); return; }
    $('keyBtn').classList.remove('warn');
    store.set('pixai_admin_token', $('token').value.trim());
    if (!r.ok) { if (!quiet) say((j.message || '读取失败') + '（' + r.status + '）', 'bad'); return; }
    show(j);
    if (!quiet) say('已刷新' + (setting ? ' · 网页当前：' + setting : ''), 'ok');
  } catch (e) { if (!quiet) say('读取失败：' + e.message, 'bad'); }
}
$('refresh').onclick = () => refresh(false);
$('keyBtn').onclick = () => openKey(true);
$('popMask').onclick = () => openKey(false);
$('save').onclick = () => { openKey(false); refresh(false); };
$('token').onkeydown = e => { if (e.key === 'Enter') $('save').onclick(); };
$('password').onkeydown = e => { if (e.key === 'Enter') $('login').onclick(); };

const closeShot = () => { $('modal').classList.remove('show'); if ($('img').src) { URL.revokeObjectURL($('img').src); $('img').removeAttribute('src'); } };
$('modalMask').onclick = closeShot; $('img').onclick = closeShot;
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeShot(); openKey(false); } });
$('shot').onclick = async () => {
  say('正在截图…');
  try {
    const r = await call('/admin/screenshot');
    if (!r.ok) { const j = await r.json().catch(() => ({})); return say((j.message || '截图失败') + '（' + r.status + '）', 'bad'); }
    $('img').src = URL.createObjectURL(await r.blob()); $('modal').classList.add('show'); say('截图已打开，点图片或空白处关闭');
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
$('login').onclick = async () => {
  if (busy) return;
  const email = $('email').value.trim();
  if (!email || !$('password').value) return say('邮箱和密码都要填', 'bad');
  busy = true; $('login').disabled = true; $('goText').textContent = '登录中…';
  lastStage = ''; lastPct = 3; setLive('正在登录…', 3); addLine('开始登录 ' + email);
  const timer = setInterval(poll, 600);
  try {
    const r = await call('/admin/login', { method: 'POST', body: JSON.stringify({ email: email, password: $('password').value }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setLive(j.message || '已登录', 100, 'ok'); say('✓ ' + (j.message || '已登录'), 'ok'); $('password').value = ''; await refresh(true); }
    else { const m = (j.message || '失败') + '（' + r.status + '）'; setLive('✕ ' + m, lastPct, 'err'); say(m, 'bad'); }
  } catch (e) { setLive('✕ 失败：' + e.message, lastPct, 'err'); say('失败：' + e.message, 'bad'); }
  finally { clearInterval(timer); busy = false; $('login').disabled = false; $('goText').textContent = '登录并切换'; }
};
refresh(true);
setInterval(() => { if (!document.hidden && !busy) refresh(true); }, 30000);
</script></body></html>`;

const ACCOUNT_FILE = env('ACCOUNT_FILE', path.join(os.tmpdir(), 'pixai-bridge-account.json'));
let account = null; // {email, at}：最近一次通过 /admin 登录的账号，只记邮箱，不记密码
fs.readFile(ACCOUNT_FILE, 'utf8').then(text => { const v = json(text, null); if (v?.email) account = { email: String(v.email), at: Number(v.at) || 0 }; }, () => {});

app.get('/admin', (_req, res) => res.type('html').send(ADMIN_HTML));

app.use('/admin', (req, res, next) => {
  if (!CONFIG.token) return res.status(403).json({ message: '换账号需要先设置环境变量 BRIDGE_TOKEN，否则任何人都能换你的账号' });
  next();
});

app.get('/admin/state', async (_req, res) => {
  try {
    const page = await getPixAIPage();
    const status = await readPageStatus(page);
    res.json({
      ok: true, loggedIn: page.url().includes('/generator/image'), account, page: page.url(), generating,
      ratio: status.resolution.ratio, size: status.resolution.label, count: status.count, balance: status.balance, cost: status.cost
    });
  } catch (error) {
    res.status(503).json({ ok: false, message: error.message });
  }
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
const stage = (text, pct, state = 'run') => { loginProgress = { text, pct, state, at: Date.now() }; };
app.get('/admin/progress', (_req, res) => res.json(loginProgress));

async function switchAccount(email, password) {
  stage('连接浏览器', 5);
  const ctx = (await connectBrowser()).contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('pixai.art')) ?? await ctx.newPage();

  // 清掉旧账号的登录状态（cookie + 本地存储）
  stage('清除旧账号的登录状态', 15);
  await ctx.clearCookies();
  await page.goto('https://pixai.art/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } }).catch(() => {});

  stage('打开登录页', 30);
  await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
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

  // 登录后回到生图页，重新选好模型、比例
  stage('回到生图页，选择模型和比例', 88);
  await (opening ??= openGeneratorPage().finally(() => { opening = null; }));
  batcher.runs.clear(); // 旧账号时缓存的批次作废
}

app.post('/admin/login', async (req, res) => {
  const email = String(req.body?.email || '').trim(), password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ message: '邮箱和密码都要填' });
  if (generating) return res.status(409).json({ message: '反代正在出图，画完再换账号' });
  const job = settingLock.then(() => switchAccount(email, password));
  settingLock = job.catch(() => {});
  try {
    await job;
    account = { email, at: Date.now() };
    fs.writeFile(ACCOUNT_FILE, JSON.stringify(account)).catch(() => {});
    stage('已登录并回到生图页', 100, 'ok');
    console.log('已切换 PixAI 账号');
    res.json({ ok: true, message: '已登录并回到生图页' });
  } catch (error) {
    stage('换账号失败', loginProgress.pct, 'err');
    console.error('换账号失败：', error.message); // 不记录密码
    res.status(502).json({ ok: false, message: error.message });
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

  const hint = readHint(params.bridge_batch);

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
      const { file, index, size, taskId } = await batcher.take(prompt, hint);

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
