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
  // 找不到生图页时（比如 VPS 重启后浏览器是空白页）自动打开的地址
  pixaiUrl: env('PIXAI_URL', 'https://pixai.art/zh/generator/image'),
  // 打开生图页后自动选的模型（名字必须以此结尾）；设成空字符串则不自动选
  model: env('PIXAI_MODEL', 'MiaoMiao RealSkin 1.4')
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
  if (CONFIG.token && req.path !== '/health' && req.headers.authorization !== `Bearer ${CONFIG.token}`) {
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

  await selectModel(page, CONFIG.model).catch(error => console.error('自动选模型失败，请人工检查：', error.message));
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

function makeZip(files) {
  const local = [], central = [];
  let offset = 0;

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

let settingLock = Promise.resolve();

async function generateBatch(prompt, count) {
  await settingLock;
  generating = true;
  try {
    const page = await getPixAIPage();

    const oldIds = await page.evaluate(selector =>
      Array.from(document.querySelectorAll(selector)).map(card => card.getAttribute('data-task-id')),
      CARD
    );

    const switched = await setQuantity(page, count);
    const needed = switched ? count : CONFIG.pageCount;

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

    // 以卡片上实际有几张为准，不写死 4
    const actual = await card.locator(THUMB).count();
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

  const processRequest = async () => {
    if (gone) {
      console.log('请求已被取消，跳过');
      return;
    }
    try {
      const { file, index, size, taskId } = await batcher.take(prompt, hint);

      const zip = makeZip([{
        name: `image_${index + 1}${path.extname(file.name) || '.png'}`,
        data: file.data
      }]);

      res.status(201);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="pixai-image.zip"');
      res.send(zip);

      console.log(`任务 ${taskId}：已返回第 ${index + 1}/${size} 张${hint ? '' : '（旧插件，按提示词归批）'}`);
    } catch (error) {
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
