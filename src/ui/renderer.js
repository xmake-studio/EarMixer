'use strict';

const SLOTS = ['A', 'B'];
const NAMES = { A: 'Созвон 1', B: 'Созвон 2' };
const SIDE_BADGE = { left: 'Л', right: 'П', both: 'Л+П', mute: '—' };
const SIDE_FREQ = { A: 660, B: 440 };
const SERVICE_NAMES = { telemost: 'Телемост', zoom: 'Zoom' };
const SERVICE_HINTS = {
  telemost: 'Ссылка или ID встречи Телемоста',
  zoom: 'Ссылка или ID встречи Zoom (zoom.us/j/…)',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let settings = null;
const views = {};
const els = {};
const levels = { A: { target: 0, shown: 0 }, B: { target: 0, shown: 0 } };

// ---------------------------------------------------------------- построение

function buildCalls() {
  const tpl = $('#callTpl');
  const root = $('#calls');
  for (const slot of SLOTS) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.slot = slot;
    $('.name', node).textContent = NAMES[slot];
    root.appendChild(node);

    const e = {
      root: node,
      badge: $('.ear-badge', node),
      status: $('.status', node),
      url: $('.url', node),
      back: $('[data-nav="back"]', node),
      volRange: $('.vol-range', node),
      volVal: $('.vol-val', node),
      meter: $('.meter-fill', node),
      mic: $('.btn.mic', node),
      micLabel: $('.mic-label', node),
      host: $('.view-host', node),
      placeholder: $('.placeholder', node),
    };
    els[slot] = e;

    $('.join', node).addEventListener('submit', (ev) => {
      ev.preventDefault();
      window.ear.nav(slot, 'go', e.url.value);
      e.url.blur();
    });
    e.url.addEventListener('focus', () => e.url.select());

    $$('[data-nav]', node).forEach((b) => b.addEventListener('click', () => window.ear.nav(slot, b.dataset.nav)));
    $$('[data-side]', node).forEach((b) => b.addEventListener('click', () => window.ear.set(slot, { side: b.dataset.side })));
    $$('[data-service]', node).forEach((b) => b.addEventListener('click', () => window.ear.set(slot, { service: b.dataset.service })));

    e.volRange.addEventListener('input', () => {
      const v = Number(e.volRange.value) / 100;
      paintVolume(slot, v);
      window.ear.set(slot, { volume: v });
    });
    e.volRange.addEventListener('dblclick', () => window.ear.set(slot, { volume: 1 }));

    e.mic.addEventListener('click', () => window.ear.set(slot, { mic: !settings.slots[slot].mic }));
    $('.btn.test', node).addEventListener('click', () => playTest(slot));
  }
}

// ---------------------------------------------------------------- отрисовка состояния

function paintVolume(slot, v) {
  const e = els[slot];
  e.volRange.value = Math.round(v * 100);
  e.volRange.style.setProperty('--p', `${(v / 2) * 100}%`);
  e.volVal.textContent = `${Math.round(v * 100)}%`;
}

function render() {
  if (!settings) return;
  for (const slot of SLOTS) {
    const s = settings.slots[slot];
    const e = els[slot];
    e.root.dataset.side = s.side;
    e.badge.textContent = SIDE_BADGE[s.side];
    $$('[data-side]', e.root).forEach((b) => b.classList.toggle('active', b.dataset.side === s.side));
    if (document.activeElement !== e.volRange) paintVolume(slot, s.volume);
    e.mic.classList.toggle('off', !s.mic);
    e.micLabel.textContent = s.mic ? 'Микрофон' : 'Микрофон выкл';
    $$('[data-service]', e.root).forEach((b) => b.classList.toggle('active', b.dataset.service === s.service));
    e.url.placeholder = SERVICE_HINTS[s.service];
    e.root.dataset.service = s.service;
  }

  // Карта «ухо → созвон» в шапке
  const label = (slot) => (settings.slots.A.service === settings.slots.B.service
    ? NAMES[slot] : `${NAMES[slot]} · ${SERVICE_NAMES[settings.slots[slot].service]}`);
  const hears = (ear) => SLOTS.filter((slot) => [ear, 'both'].includes(settings.slots[slot].side)).map(label);
  for (const [ear, id] of [['left', 'mapLeft'], ['right', 'mapRight']]) {
    const list = hears(ear);
    const el = document.getElementById(id);
    el.textContent = list.length ? list.join(' + ') : 'тишина';
    el.classList.toggle('on', list.length > 0);
  }

  $('#calls').dataset.layout = settings.layout;
  $$('#layoutSeg button').forEach((b) => b.classList.toggle('active', b.dataset.layout === settings.layout));
  requestAnimationFrame(sendBounds);
}

function renderView(slot) {
  const v = views[slot];
  const e = els[slot];
  if (!v || !e) return;
  e.status.classList.toggle('live', v.inMeeting && !v.loading);
  e.status.textContent = v.loading ? 'загрузка…' : v.inMeeting ? '● встреча открыта' : (v.title || 'не во встрече');
  e.back.disabled = !v.canGoBack;
  if (document.activeElement !== e.url) e.url.value = v.url || '';
}

// ---------------------------------------------------------------- размещение WebContentsView

function sendBounds() {
  const rects = {};
  for (const slot of SLOTS) {
    const host = els[slot].host;
    const r = host.getBoundingClientRect();
    rects[slot] = host.offsetParent ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
  }
  window.ear.setBounds(rects);
}

// ---------------------------------------------------------------- индикаторы уровня

function animateMeters() {
  for (const slot of SLOTS) {
    const l = levels[slot];
    l.shown = Math.max(l.target, l.shown * 0.86);
    l.target *= 0.6;
    const db = 20 * Math.log10(Math.max(l.shown, 1e-5));
    const pct = Math.min(100, Math.max(0, ((db + 54) / 54) * 100));
    els[slot].meter.style.width = `${pct}%`;
  }
  requestAnimationFrame(animateMeters);
}

// ---------------------------------------------------------------- устройство вывода

async function refreshSinks() {
  const select = $('#sinkSelect');
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.some((d) => d.kind === 'audiooutput' && !d.label)) {
      // Без разрешения на медиа Chromium не отдаёт названия устройств.
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    }
  } catch { /* покажем хотя бы вариант по умолчанию */ }

  const outs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  select.innerHTML = '';
  const def = new Option('Системное устройство по умолчанию', '');
  select.add(def);
  for (const d of outs) select.add(new Option(d.label || 'Устройство', d.label));
  const wanted = settings?.sinkLabel || '';
  select.value = outs.some((d) => d.label === wanted) ? wanted : '';
}

function currentSinkId() {
  return navigator.mediaDevices.enumerateDevices()
    .then((ds) => ds.find((d) => d.kind === 'audiooutput' && d.label === settings.sinkLabel)?.deviceId || '')
    .catch(() => '');
}

// ---------------------------------------------------------------- тестовый сигнал

let testCtx = null;
async function playTest(slot) {
  const s = settings.slots[slot];
  if (!testCtx) testCtx = new AudioContext();
  const ctx = testCtx;
  if (ctx.state === 'suspended') await ctx.resume();
  if (typeof ctx.setSinkId === 'function') {
    const id = settings.sinkLabel ? await currentSinkId() : '';
    if (ctx.sinkId !== id) await ctx.setSinkId(id).catch(() => {});
  }

  const merger = ctx.createChannelMerger(2);
  merger.connect(ctx.destination);
  const gain = ctx.createGain();
  const channels = { left: [0], right: [1], both: [0, 1], mute: [] }[s.side];
  channels.forEach((ch) => gain.connect(merger, 0, ch));

  const t0 = ctx.currentTime + 0.02;
  const vol = 0.25 * s.volume;
  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator();
    osc.frequency.value = SIDE_FREQ[slot] * (i === 2 ? 1.5 : 1);
    const env = ctx.createGain();
    const start = t0 + i * 0.22;
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(vol, start + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    osc.connect(env).connect(gain);
    osc.start(start);
    osc.stop(start + 0.2);
  }
  setTimeout(() => merger.disconnect(), 1000);
}

// ---------------------------------------------------------------- старт

async function main() {
  buildCalls();

  $('#swapBtn').addEventListener('click', () => window.ear.swap());
  $$('#layoutSeg button').forEach((b) => b.addEventListener('click', () => window.ear.setGlobal({ layout: b.dataset.layout })));
  $('#sinkSelect').addEventListener('change', (e) => window.ear.setGlobal({ sinkLabel: e.target.value }));

  window.ear.on('settings', (s) => { settings = s; render(); });
  window.ear.on('view-state', (v) => {
    views[v.slot] = v;
    els[v.slot].placeholder.hidden = !v.loading && !!v.url;
    renderView(v.slot);
  });
  window.ear.on('level', ({ slot, level }) => {
    if (levels[slot]) levels[slot].target = Math.max(levels[slot].target, level);
  });

  const state = await window.ear.getState();
  settings = state.settings;
  Object.assign(views, state.views);
  render();
  SLOTS.forEach(renderView);

  const ro = new ResizeObserver(sendBounds);
  SLOTS.forEach((slot) => ro.observe(els[slot].host));
  window.addEventListener('resize', sendBounds);
  sendBounds();

  // Ctrl+Shift+S — поменять уши, Ctrl+1/2 — микрофон созвона 1/2
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyS') { e.preventDefault(); window.ear.swap(); }
    if (e.ctrlKey && !e.shiftKey && (e.key === '1' || e.key === '2')) {
      const slot = e.key === '1' ? 'A' : 'B';
      window.ear.set(slot, { mic: !settings.slots[slot].mic });
    }
  });

  refreshSinks();
  navigator.mediaDevices.addEventListener('devicechange', refreshSinks);
  animateMeters();
}

main();
