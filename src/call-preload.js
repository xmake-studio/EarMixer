'use strict';

// Preload для страниц Телемоста. Работает в изолированном мире, а сам перехват звука
// выполняется в основном мире страницы (earMixerMain) — до любых скриптов Телемоста.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const init = ipcRenderer.sendSync('call:init');

if (init) {
  const key = `__em_${Math.random().toString(36).slice(2)}`;
  contextBridge.exposeInMainWorld(`${key}b`, {
    level: (v) => ipcRenderer.send('call:level', v),
  });
  runInMain(earMixerMain, [init.cfg, key]);
  ipcRenderer.on('call:config', (_e, cfg) => {
    runInMain((k, c) => { const api = window[k]; if (api) api.configure(c); }, [key, cfg]);
  });
}

function runInMain(func, args) {
  if (typeof contextBridge.executeInMainWorld === 'function') {
    contextBridge.executeInMainWorld({ func, args });
  } else {
    webFrame.executeJavaScript(`(${func})(...${JSON.stringify(args)})`);
  }
}

// ============================================================================
// Всё ниже сериализуется и исполняется в основном мире страницы.
// Идея: любой звук страницы (WebRTC-потоки в <audio>/<video> и узлы WebAudio,
// подключённые к destination) сводится в моно и подаётся ровно в один канал —
// левый или правый. Микрофон можно глушить поверх кнопки Телемоста.
// ============================================================================
function earMixerMain(initialCfg, key) {
  'use strict';

  // Фрейм уже обслуживается перехватчиком родителя (см. patchRealm) — второй не нужен.
  const PATCHED = Symbol.for('earmixer.patched');
  if (window[key] || window[PATCHED] || !window.AudioContext || !window.AudioNode) return;
  Object.defineProperty(window, PATCHED, { value: true });

  const bridge = window[`${key}b`];
  const cfg = Object.assign({ side: 'left', volume: 1, mic: true, sinkLabel: '' }, initialCfg);
  const log = (...a) => console.debug('[EarMixer]', ...a);

  const AC = window.AudioContext;
  const origConnect = AudioNode.prototype.connect;
  const origDisconnect = AudioNode.prototype.disconnect;

  /** @type {Map<BaseAudioContext, object>} */
  const routers = new Map();
  let ownCtx = null;
  let pageSinkId = '';

  // ---------------------------------------------------------------- роутер
  // [вход] → моно-downmix → (анализатор) → громкость → ChannelMerger[L|R] → destination
  function makeRouter(ctx) {
    const input = ctx.createGain();
    input.channelCount = 1;
    input.channelCountMode = 'explicit';
    input.channelInterpretation = 'speakers';
    const vol = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    origConnect.call(input, analyser);
    origConnect.call(input, vol);
    origConnect.call(merger, ctx.destination);
    const r = { ctx, input, vol, merger, analyser, buf: new Float32Array(1024), wired: null };
    routers.set(ctx, r);
    applyRouter(r);
    applySink(r);
    return r;
  }

  function routerFor(ctx) {
    return routers.get(ctx) || makeRouter(ctx);
  }

  function applyRouter(r) {
    const want = { left: [0], right: [1], both: [0, 1], mute: [] }[cfg.side] || [0];
    const sig = want.join(',');
    if (r.wired !== sig) {
      try { origDisconnect.call(r.vol, r.merger); } catch (e) { /* не был подключён */ }
      for (const ch of want) origConnect.call(r.vol, r.merger, 0, ch);
      r.wired = sig;
    }
    const v = Math.max(0, Math.min(2, Number(cfg.volume) || 0));
    r.vol.gain.setTargetAtTime(v, r.ctx.currentTime, 0.02);
  }

  // ---------------------------------------------------------------- устройство вывода
  async function resolveSinkId() {
    if (!cfg.sinkLabel) return pageSinkId || '';
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const d = devices.find((x) => x.kind === 'audiooutput' && x.label === cfg.sinkLabel);
      return d ? d.deviceId : (pageSinkId || '');
    } catch (e) {
      return pageSinkId || '';
    }
  }

  async function applySink(r) {
    // Контексты страницы трогаем только если пользователь явно выбрал устройство в EarMixer.
    if (!r || typeof r.ctx.setSinkId !== 'function') return;
    if (r.ctx !== ownCtx && !cfg.sinkLabel) return;
    const id = await resolveSinkId();
    if (r.ctx.state === 'closed' || r.ctx.sinkId === id) return;
    try { await r.ctx.setSinkId(id); } catch (e) { log('setSinkId failed', e); }
  }

  // ---------------------------------------------------------------- перехват WebAudio
  // Проверки типов без instanceof — объекты могут прийти из дочернего фрейма (другой realm).
  const tag = (o) => Object.prototype.toString.call(o);
  const isDest = (o) => o != null && tag(o) === '[object AudioDestinationNode]';
  const isOffline = (ctx) => tag(ctx) === '[object OfflineAudioContext]';
  const isStream = (o) => o != null && tag(o) === '[object MediaStream]';

  AudioNode.prototype.connect = function connect(dest, output, input) {
    if (isDest(dest) && !isOffline(dest.context)) {
      const r = routerFor(dest.context);
      origConnect.call(this, r.input, output === undefined ? 0 : output, 0);
      return dest;
    }
    return origConnect.apply(this, arguments);
  };

  AudioNode.prototype.disconnect = function disconnect(dest, output) {
    if (isDest(dest)) {
      const r = routers.get(dest.context);
      if (r) {
        return output === undefined
          ? origDisconnect.call(this, r.input)
          : origDisconnect.call(this, r.input, output);
      }
    }
    return origDisconnect.apply(this, arguments);
  };

  function getOwnCtx() {
    if (!ownCtx || ownCtx.state === 'closed') {
      ownCtx = new AC({ latencyHint: 'interactive' });
      const ctx = ownCtx;
      const resume = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
      ctx.addEventListener('statechange', resume);
      for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, true);
      makeRouter(ctx);
      resume();
    }
    return ownCtx;
  }

  // ---------------------------------------------------------------- перехват <audio>/<video>
  // Элемент продолжает воспроизводить поток (это нужно Chrome, чтобы удалённый WebRTC-звук
  // вообще тёк в WebAudio), но реально заглушён. Его muted/volume для страницы — виртуальные.
  const mediaProto = HTMLMediaElement.prototype;
  const desc = (n) => Object.getOwnPropertyDescriptor(mediaProto, n);
  const srcObjectDesc = desc('srcObject');
  const mutedDesc = desc('muted');
  const volumeDesc = desc('volume');
  const elState = new WeakMap();

  function takeOver(el) {
    let st = elState.get(el);
    if (st) return st;
    st = {
      vMuted: mutedDesc.get.call(el),
      vVolume: volumeDesc.get.call(el),
      stream: null, sources: [], gain: null, cleanup: null,
    };
    elState.set(el, st);
    Object.defineProperty(el, 'muted', {
      configurable: true,
      get() { return st.vMuted; },
      set(v) {
        v = !!v;
        if (v === st.vMuted) return;
        st.vMuted = v;
        updateEl(el);
        el.dispatchEvent(new Event('volumechange'));
      },
    });
    Object.defineProperty(el, 'volume', {
      configurable: true,
      get() { return st.vVolume; },
      set(v) {
        v = Number(v);
        if (!(v >= 0 && v <= 1)) {
          throw new DOMException(`The volume provided (${v}) is outside the range [0, 1].`, 'IndexSizeError');
        }
        if (v === st.vVolume) return;
        st.vVolume = v;
        updateEl(el);
        el.dispatchEvent(new Event('volumechange'));
      },
    });
    mutedDesc.set.call(el, true);
    st.onPlayState = () => updateEl(el);
    for (const ev of ['play', 'playing', 'pause', 'emptied', 'ended']) el.addEventListener(ev, st.onPlayState);
    return st;
  }

  function release(el) {
    const st = elState.get(el);
    if (!st) return;
    detach(st);
    if (st.gain) { try { st.gain.disconnect(); } catch (e) { /* ok */ } }
    for (const ev of ['play', 'playing', 'pause', 'emptied', 'ended']) el.removeEventListener(ev, st.onPlayState);
    delete el.muted;
    delete el.volume;
    mutedDesc.set.call(el, st.vMuted);
    volumeDesc.set.call(el, st.vVolume);
    elState.delete(el);
  }

  function detach(st) {
    if (st.cleanup) st.cleanup();
    st.cleanup = null;
    for (const s of st.sources) { try { s.disconnect(); } catch (e) { /* ok */ } }
    st.sources = [];
  }

  function attach(el, stream) {
    const st = takeOver(el);
    detach(st);
    st.stream = stream;
    const onTracks = () => { if (st.stream === stream) rebuild(el, st); };
    stream.addEventListener('addtrack', onTracks);
    stream.addEventListener('removetrack', onTracks);
    st.cleanup = () => {
      stream.removeEventListener('addtrack', onTracks);
      stream.removeEventListener('removetrack', onTracks);
    };
    rebuild(el, st);
  }

  function rebuild(el, st) {
    for (const s of st.sources) { try { s.disconnect(); } catch (e) { /* ok */ } }
    st.sources = [];
    const tracks = st.stream.getAudioTracks();
    if (!tracks.length) return;
    const ctx = getOwnCtx();
    if (!st.gain || st.gain.context !== ctx) {
      st.gain = ctx.createGain();
      origConnect.call(st.gain, routerFor(ctx).input);
    }
    for (const t of tracks) {
      try {
        const src = ctx.createMediaStreamSource(new MediaStream([t]));
        origConnect.call(src, st.gain);
        st.sources.push(src);
      } catch (e) { log('createMediaStreamSource failed', e); }
    }
    updateEl(el);
  }

  function updateEl(el) {
    const st = elState.get(el);
    if (!st || !st.gain) return;
    const g = st.vMuted || el.paused ? 0 : st.vVolume;
    st.gain.gain.setTargetAtTime(g, st.gain.context.currentTime, 0.015);
  }

  Object.defineProperty(mediaProto, 'srcObject', {
    configurable: true,
    enumerable: srcObjectDesc.enumerable,
    get() { return srcObjectDesc.get.call(this); },
    set(v) {
      srcObjectDesc.set.call(this, v);
      try {
        if (isStream(v)) attach(this, v);
        else release(this);
      } catch (e) { log('srcObject hook failed', e); }
    },
  });

  // Если Телемост сам выбирает динамик — повторяем выбор для нашего контекста.
  if (typeof mediaProto.setSinkId === 'function') {
    const origSetSinkId = mediaProto.setSinkId;
    mediaProto.setSinkId = function setSinkId(id) {
      pageSinkId = id || '';
      if (ownCtx) applySink(routers.get(ownCtx));
      return origSetSinkId.call(this, id);
    };
  }

  // ---------------------------------------------------------------- микрофон
  // enabled трека для страницы виртуальный; реально трек включён, только если
  // и Телемост, и EarMixer разрешают говорить в этот созвон.
  const trackProto = MediaStreamTrack.prototype;
  const enabledDesc = Object.getOwnPropertyDescriptor(trackProto, 'enabled');
  const gateState = new WeakMap();
  const gated = new Set();

  function gate(track, virtualEnabled) {
    if (!track || track.kind !== 'audio') return track;
    let st = gateState.get(track);
    if (!st) {
      st = { v: enabledDesc.get.call(track) };
      gateState.set(track, st);
      gated.add(track);
      Object.defineProperty(track, 'enabled', {
        configurable: true,
        get() { return st.v; },
        set(v) { st.v = !!v; applyGate(track); },
      });
    }
    if (virtualEnabled !== undefined) st.v = virtualEnabled;
    applyGate(track);
    return track;
  }

  function applyGate(track) {
    const st = gateState.get(track);
    if (st) enabledDesc.set.call(track, st.v && cfg.mic !== false);
  }

  if (window.MediaDevices && MediaDevices.prototype.getUserMedia) {
    const origGUM = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = function getUserMedia(constraints) {
      return origGUM.call(this, constraints).then((stream) => {
        stream.getAudioTracks().forEach((t) => gate(t));
        return stream;
      });
    };
  }

  const origTrackClone = trackProto.clone;
  trackProto.clone = function clone() {
    const c = origTrackClone.call(this);
    const st = gateState.get(this);
    if (st) gate(c, st.v);
    return c;
  };

  const origStreamClone = MediaStream.prototype.clone;
  MediaStream.prototype.clone = function clone() {
    const c = origStreamClone.call(this);
    const src = this.getAudioTracks();
    c.getAudioTracks().forEach((t, i) => {
      const st = src[i] && gateState.get(src[i]);
      if (st) gate(t, st.v);
    });
    return c;
  };

  // ---------------------------------------------------------------- дочерние фреймы
  // В about:blank-iframe у страницы «чистые» AudioNode/HTMLMediaElement, и через них
  // звук обошёл бы маршрутизацию. При первом обращении к такому фрейму переносим туда
  // наши перехватчики — фрейм работает через роутер и настройки родителя.
  const REALM_PATCHES = [
    ['AudioNode', ['connect', 'disconnect']],
    ['HTMLMediaElement', ['srcObject', 'setSinkId']],
    ['MediaDevices', ['getUserMedia']],
    ['MediaStreamTrack', ['clone']],
    ['MediaStream', ['clone']],
  ];

  function patchRealm(w) {
    try {
      if (!w || w === window || w[PATCHED] || !w.AudioNode) return;
      Object.defineProperty(w, PATCHED, { value: true });
      for (const [iface, props] of REALM_PATCHES) {
        const from = window[iface] && window[iface].prototype;
        const to = w[iface] && w[iface].prototype;
        if (!from || !to) continue;
        for (const p of props) {
          const d = Object.getOwnPropertyDescriptor(from, p);
          if (d) Object.defineProperty(to, p, d);
        }
      }
    } catch (e) { /* чужой origin — у него свой preload */ }
  }

  for (const iface of ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement']) {
    const proto = window[iface] && window[iface].prototype;
    if (!proto) continue;
    for (const prop of ['contentWindow', 'contentDocument']) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.get) continue;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get() {
          const v = d.get.call(this);
          if (v) patchRealm(prop === 'contentWindow' ? v : v.defaultView);
          return v;
        },
      });
    }
  }

  // ---------------------------------------------------------------- индикатор уровня
  let lastSent = 0;
  setInterval(() => {
    let peak = 0;
    for (const [ctx, r] of routers) {
      if (ctx.state === 'closed') { routers.delete(ctx); continue; }
      r.analyser.getFloatTimeDomainData(r.buf);
      for (let i = 0; i < r.buf.length; i++) {
        const a = Math.abs(r.buf[i]);
        if (a > peak) peak = a;
      }
    }
    for (const t of gated) if (t.readyState === 'ended') gated.delete(t);
    if (bridge && (peak > 0.001 || lastSent > 0.001)) {
      bridge.level(peak);
      lastSent = peak;
    }
  }, 100);

  // ---------------------------------------------------------------- API для preload
  function configure(c) {
    Object.assign(cfg, c);
    routers.forEach(applyRouter);
    routers.forEach(applySink);
    gated.forEach(applyGate);
  }

  Object.defineProperty(window, key, { value: { configure }, enumerable: false });
  log('audio routing active:', cfg.side);
}
