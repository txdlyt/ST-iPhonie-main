// GitHub 图床: pictures are put in a GitHub repository (the contents API) and told by two links, jsDelivr's and GitHub's own.
// The token is a key of the phone (core/keys.js, 'github'); what is kept here is only where the pictures go.

export const HOST_LINKS = Object.freeze(['jsdelivr', 'raw']);
export const DEFAULT_HOST = Object.freeze({auto: false, repo: '', branch: 'main', folder: 'images', byCard: true, link: 'jsdelivr'});

/** "owner/repo", or a github.com address of it: {owner, repo}, null when it is neither. */
export function parseRepo(text) {
  const value = String(text ?? '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?:\/.*)?$/.exec(value);
  return match ? {owner: match[1], repo: match[2]} : null;
}
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
/** A folder path made of plain parts: no dots-only parts, no characters a path or an address cannot carry. */
const segments = (value, max = 80) => String(value ?? '').split(/[\\/]+/).map(part => part.replace(/[\u0000-\u001f\u007f:*?"<>|#%\[\]{}^`~]/g, '').trim().slice(0, max)).filter(part => part && !/^\.+$/.test(part));
export function normalizeHost(value) {
  const input = value && typeof value === 'object' ? value : {};
  const repo = parseRepo(input.repo);
  return {
    auto: input.auto === true,
    repo: repo ? `${repo.owner}/${repo.repo}` : clean(input.repo, 140),
    branch: clean(input.branch, 100).replace(/\s+/g, '') || DEFAULT_HOST.branch,
    folder: segments(input.folder).join('/') || (input.folder === '' ? '' : DEFAULT_HOST.folder),
    byCard: input.byCard !== false,
    link: HOST_LINKS.includes(input.link) ? input.link : DEFAULT_HOST.link
  };
}
export const hostReady = (config, token) => !!(token && parseRepo(config?.repo));

const ext = blob => ({'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif'}[String(blob?.type).toLowerCase()] || 'png');
const stamp = date => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
async function digest(bytes) {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...hash.slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/** Where a picture goes in the repository: folder / card / name. The same picture (same bytes, same minute) is the same path. */
export function hostPath(config, {cardName = '', name}) {
  const parts = [...segments(config.folder)];
  if (config.byCard) parts.push(segments(cardName || '未分类', 40).join('') || '未分类');
  parts.push(name);
  return parts.join('/');
}
const enc = path => path.split('/').map(encodeURIComponent).join('/');
/** Both addresses of a stored picture. */
export function hostLinks(config, path) {
  const repo = parseRepo(config.repo);
  if (!repo) return null;
  return {
    jsdelivr: `https://cdn.jsdelivr.net/gh/${repo.owner}/${repo.repo}@${encodeURIComponent(config.branch)}/${enc(path)}`,
    raw: `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(config.branch)}/${enc(path)}`
  };
}
function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
const headers = token => ({Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'});
const API = 'https://api.github.com';
/** What GitHub said, in words (the token is never in them). */
async function failure(response, what) {
  let detail = '';
  try { detail = String((await response.json())?.message || ''); } catch { /* no body */ }
  const code = response.status;
  const why = code === 401 ? '令牌不对或已过期' : code === 403 ? (/rate limit|abuse|secondary/i.test(detail) ? '请求太频繁，GitHub 让稍后再试' : '令牌没有这个仓库的写入权限（要 Contents 读写）') : code === 404 ? '找不到这个仓库，或令牌看不到它（仓库名、令牌的仓库范围要对）' : code === 409 ? '仓库正忙，稍后再试' : code === 422 ? `GitHub 不接受（${detail || '分支不存在？'}）` : `GitHub 返回 ${code}${detail ? '：' + detail : ''}`;
  return Object.assign(Error(`${what}失败：${why}`), {code: 'HOST', status: code});
}
/**
 * Puts a picture in the repository. The same path already there is the same picture, so it counts as done.
 * Returns {path, links, bytes}.
 */
export async function uploadImage({fetch = globalThis.fetch.bind(globalThis), token, config, blob, cardName = '', now = new Date(), signal}) {
  const repo = parseRepo(config?.repo);
  if (!repo) throw Error('图床还没填仓库（owner/仓库名）');
  if (!token) throw Error('图床还没填令牌');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bytes.length) throw Error('图片是空的');
  if (bytes.length > 25 * 1024 * 1024) throw Error('图片超过 25MB，不传');
  const name = `${stamp(now)}-${await digest(bytes)}.${ext(blob)}`;
  const path = hostPath(config, {cardName, name});
  const response = await fetch(`${API}/repos/${repo.owner}/${repo.repo}/contents/${enc(path)}`, {
    method: 'PUT', headers: {...headers(token), 'Content-Type': 'application/json'}, signal,
    body: JSON.stringify({message: `upload ${name}`, content: base64(bytes), branch: config.branch})
  });
  if (response.status === 422) {
    // "sha wasn't supplied": this path is there already (the same bytes uploaded at the same second).
    const text = await response.clone().text().catch(() => '');
    if (/sha/i.test(text)) return {path, links: hostLinks(config, path), bytes: bytes.length};
  }
  if (!response.ok) throw await failure(response, '上传');
  return {path, links: hostLinks(config, path), bytes: bytes.length};
}
/** Whether the repository can be written with this token: {ok, private, message}. */
export async function testHost({fetch = globalThis.fetch.bind(globalThis), token, config, signal}) {
  const repo = parseRepo(config?.repo);
  if (!repo) throw Error('仓库要写成 owner/仓库名，如 txdlyt/my-images');
  if (!token) throw Error('还没填令牌');
  const response = await fetch(`${API}/repos/${repo.owner}/${repo.repo}`, {headers: headers(token), signal});
  if (!response.ok) throw await failure(response, '连接');
  const info = await response.json().catch(() => ({}));
  const push = info?.permissions?.push !== false;
  const branch = await fetch(`${API}/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(config.branch)}`, {headers: headers(token), signal});
  if (branch.status === 404) throw Error(`连接成功，但仓库里没有分支「${config.branch}」（空仓库要先在 GitHub 上建一个文件）`);
  return {
    ok: push, private: !!info.private,
    message: !push ? '连上了，但这个令牌只能读，不能写入（要 Contents: Read and write）'
      : info.private ? '连上了，可以写入。注意：仓库是私有的，外链别人打不开，想要外链能用就改成公开仓库'
      : '连上了，可以写入'
  };
}
