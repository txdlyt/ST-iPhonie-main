// The LoRAs of the ComfyUI scheme in use, one row each: a switch (in this picture or not), the strength and, for a
// full LoraLoader, how much it changes the reading of the prompt. Changed in place and saved at once.
import {esc, btn, field, input, select, help, groupTitle} from './common.js';
import {icon} from './icons.js';

export const shortLora = file => String(file || 'LoRA').split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|bin)$/i, '');
const amount = value => { const n = Number(value); return Number.isFinite(n) ? n : 1; };

export function comfyLoraPanel({ctx, api, rerender}) {
  // LoRA files read from ComfyUI (shared by every 添加 sheet while the app is open).
  let names = [], loaded = false, request = 0, controller = null, armed = '', disposed = false;
  function row(n, off) {
    const name = esc(shortLora(n.name));
    if (n.reason) return `<div class="lora-row locked"><div class="lora-head"><strong title="${esc(n.name)}">${name}</strong></div><p class="hint error-copy">${esc(n.reason)}</p></div>`;
    // −2 to 2 covers nearly every LoRA; a workflow's own stronger value widens the range instead of being cut down.
    const slider = (key, label, value) => `<label class="lora-strength"><span>${label}</span><input class="slider" type="range" min="${Math.min(-2, Math.floor(amount(value)))}" max="${Math.max(2, Math.ceil(amount(value)))}" step="0.05" value="${amount(value)}" data-lora-strength="${key}" data-id="${esc(n.id)}" aria-label="${name} ${label}"${off ? ' disabled' : ''}><output>${amount(value)}</output></label>`;
    return `<div class="lora-row${off ? ' off' : ''}">
      <div class="lora-head"><input type="checkbox" class="switch" data-lora-toggle="${esc(n.id)}" ${off ? '' : 'checked'} aria-label="使用 ${name}"><strong title="${esc(n.name)}">${name}</strong>${btn('lora-remove', armed === n.id ? '再点移除' : icon('trash'), 'text-button', `data-id="${esc(n.id)}" aria-label="从方案里移除 ${name}"`)}</div>
      ${slider('strength_model', '强度', n.strength_model)}${n.modelOnly ? '' : slider('strength_clip', '文字', n.strength_clip)}
    </div>`;
  }
  function html(info) {
    if (!info) return '';
    const off = new Set(info.disabled), using = info.nodes.filter(n => !off.has(n.id)).length;
    return groupTitle(`LoRA · ${using}/${info.nodes.length} 在用`, help('每行一个 LoRA。开关决定这次画不画进去，关掉的仍留在方案里；「强度」是对画面的影响，「文字」是对提示词理解的影响，1 是原样，0 是没有。改动马上保存进正在用的方案。'))
      + (info.error ? `<p class="hint error-copy">${esc(info.error)}</p>` : '')
      + (info.nodes.length ? `<div class="group pad lora-list">${info.nodes.map(n => row(n, off.has(n.id))).join('')}</div>` : '<p class="hint">这套方案里还没有 LoRA。</p>')
      + `<div class="actions">${btn('lora-add', icon('add') + '添加 LoRA', 'secondary', info.error ? 'disabled' : '')}</div>`;
  }
  function done(result) {
    if (result?.copied) ctx.notify(`默认工作流不会被改：已另存为「${result.name}」并换成它`);
    rerender();
  }
  const edit = change => { try { done(api.editComfyLoras(change)); } catch (error) { ctx.notify(error.message, {error: true}); rerender(); } };
  /** 添加 LoRA: a file (picked from ComfyUI's list or typed) and its strength; where it goes is worked out when it can be. */
  function addSheet() {
    const info = api.comfyLoraInfo(), c = api.getState().draw.comfy;
    const d = ctx.dialog('添加 LoRA', `
      ${field('LoRA 文件', input('lora-file', '', 'text', 'autocomplete="off" spellcheck="false" placeholder="文件名.safetensors（可含子目录）"'))}
      <div class="lora-picks" data-lora-picks></div>
      <div class="actions" style="margin-top:0">${btn('lora-read', icon('refresh') + (loaded ? '重新读取 ComfyUI 里的 LoRA' : '读取 ComfyUI 里的 LoRA'), 'secondary')}</div>
      <p class="hint" data-lora-status role="status"></p>
      <div class="field"><div class="meter-label"><span>强度</span><output>1</output></div><input class="slider" type="range" min="-2" max="2" step="0.05" value="1" data-lora-new aria-label="强度"></div>
      ${info.auto ? '' : field('接在哪里', select('lora-source', '', [['', '请选择'], ...info.sources.map(s => [s.id, s.name])]), '这个工作流有好几条模型线路，选新 LoRA 接在哪一条后面（一般选最后一个 LoRA，或者主模型）。')}
      <details class="tool-fold"><summary>${icon('alert')}读不到列表？</summary><div>
        ${field('读取方式', select('lora-transport', c.loraTransport, [['tavern', '经酒馆代理'], ['direct', '浏览器直连']]), '经酒馆代理：酒馆 config.yaml 里要设 enableCorsProxy: true，改完重启酒馆。\n浏览器直连：ComfyUI 要用 --enable-cors-header 启动，而且这台设备打得开 ComfyUI 的地址（手机打不开电脑的 127.0.0.1）。\n都不行也没关系：直接填文件名（ComfyUI 里 models/loras 文件夹下的名字），画图不受影响。')}
      </div></details>
      <div class="actions">${btn('lora-add-go', icon('add') + '加进方案', 'primary')}</div>`);
    const q = s => d.body.querySelector(s);
    function picks() {
      if (!d.live) return;
      const typed = q('[data-field=lora-file]').value.trim().toLowerCase();
      const shown = names.filter(n => !typed || n.toLowerCase().includes(typed)).slice(0, 40);
      q('[data-lora-picks]').innerHTML = shown.map(n => `<button type="button" class="chip-button" data-pick="${esc(n)}" title="${esc(n)}">${esc(shortLora(n))}</button>`).join('');
      q('[data-lora-status]').textContent = loaded ? (names.length ? `ComfyUI 里有 ${names.length} 个 LoRA，点一个填进去，或者打字筛选。` : 'ComfyUI 里还没有 LoRA 文件。') : '';
    }
    async function read() {
      const ticket = ++request;
      controller?.abort(); controller = new AbortController();
      q('[data-lora-status]').textContent = '正在读取……';
      try { names = await api.comfyLoras({signal: controller.signal}); loaded = true; if (ticket === request) picks(); }
      catch (error) { if (d.live && ticket === request && !disposed) q('[data-lora-status]').textContent = '读不到：' + error.message; }
    }
    picks();
    d.body.addEventListener('input', e => {
      if (e.target.matches('[data-field=lora-file]')) picks();
      if (e.target.matches('[data-lora-new]')) e.target.previousElementSibling.querySelector('output').textContent = e.target.value;
    });
    d.body.addEventListener('change', e => { if (e.target.matches('[data-field=lora-transport]')) { api.saveDraw({comfy: {loraTransport: e.target.value}}); names = []; loaded = false; picks(); } });
    d.body.addEventListener('click', e => {
      const b = e.target.closest('[data-action], [data-pick]');
      if (!b) return;
      if (b.dataset.pick) { q('[data-field=lora-file]').value = b.dataset.pick; picks(); return; }
      if (b.dataset.action === 'lora-read') { read(); return; }
      if (b.dataset.action !== 'lora-add-go') return;
      const file = q('[data-field=lora-file]').value.trim(), value = Number(q('[data-lora-new]').value), source = q('[data-field=lora-source]')?.value || '';
      if (!file) { ctx.notify('先选或填一个 LoRA 文件'); return; }
      if (!info.auto && !source) { ctx.notify('选一下 LoRA 接在哪里'); return; }
      try { const result = api.editComfyLoras({add: {lora_name: file, strength_model: value, strength_clip: value, ...(source ? {source} : {})}}); d.close(); done(result); }
      catch (error) { ctx.notify(error.message, {error: true}); }
    });
    d.onClose(() => { request++; controller?.abort(); });
  }
  async function click(el) {
    switch (el.dataset.action) {
      case 'lora-add': addSheet(); return true;
      case 'lora-remove':
        // Two taps: the first turns the bin into 「再点移除」.
        if (armed !== el.dataset.id) { const id = armed = el.dataset.id; rerender(); setTimeout(() => { if (armed === id && !disposed) { armed = ''; rerender(); } }, 3000); return true; }
        armed = ''; edit({remove: el.dataset.id}); return true;
    }
    return false;
  }
  function change(el) {
    if (el.matches('[data-lora-toggle]')) edit({enabled: {[el.dataset.loraToggle]: el.checked}});
    else if (el.matches('[data-lora-strength]')) edit({updates: [{id: el.dataset.id, [el.dataset.loraStrength]: Number(el.value)}]});
  }
  const slide = el => { el.nextElementSibling.textContent = el.value; };
  return {html, click, change, slide, dispose() { disposed = true; request++; controller?.abort(); }};
}
