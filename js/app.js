/* Watchroom — watch videos in sync with friends.
 *
 * How it works
 * - Rooms run peer-to-peer over WebRTC (PeerJS). The person who creates a room is the
 *   host: their browser holds the room state and relays it to everyone else.
 * - Anyone can play, pause, seek, load or queue. Guests send those as actions to the host,
 *   the host applies them and broadcasts the new state.
 * - Playback state is { playing, pos, at }: "at host time `at`, the video was at `pos`".
 *   Guests estimate the host's clock with ping/pong and seek when they drift too far.
 * - If the host leaves, the longest-connected guest re-opens the room under the same code
 *   and the others reconnect to them.
 */
(() => {
  'use strict';

  // ---------- constants ----------
  const PEER_PREFIX = 'watchroom-sp91145-v1-';
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const USER_CONFIG = window.WATCHROOM_CONFIG || {};
  const YT_KEY = String(USER_CONFIG.youtubeApiKey || '').trim();
  const DM_PLAYER_ID = String(USER_CONFIG.dailymotionPlayerId || '').trim().replace(/[^\w-]/g, '');
  const PEER_OPTIONS = {
    debug: 1,
    ...(USER_CONFIG.peerServer || {}),
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        ...(Array.isArray(USER_CONFIG.iceServers) ? USER_CONFIG.iceServers : []),
      ],
    },
  };
  const DRIFT = 1.25;          // seconds out of sync before we correct
  const MAX_QUEUE = 100;
  const MAX_CHAT = 200;
  const AVATAR_COLORS = ['#ffb547', '#7cc8ff', '#b79cff', '#6fe0b0', '#ff9db0', '#f4e06d'];

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  const DEFAULT_SETTINGS = { playback: 'all', adding: 'all', chat: 'all', skip: 'instant', waitBuffer: true };
  const SETTING_VALUES = { playback: ['all', 'mods'], adding: ['all', 'mods'], chat: ['all', 'mods'], skip: ['instant', 'vote'], waitBuffer: [true, false] };
  function sanitizeSettings(s) {
    const out = { ...DEFAULT_SETTINGS };
    if (s && typeof s === 'object') for (const k of Object.keys(SETTING_VALUES)) if (SETTING_VALUES[k].includes(s[k])) out[k] = s[k];
    return out;
  }
  const idList = (a, max = 200) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x).slice(0, max).map((x) => x.slice(0, 80)) : []);

  // Shared by host and guests: who may do what.
  const me = () => room.users.find((u) => u.id === myId) || null;
  const iAmMod = () => { const u = me(); return !!u && u.role !== 'member'; };
  const votesNeeded = () => Math.floor(Math.max(1, room.users.length) / 2) + 1;
  const liveVoters = () => (room.votes && room.media && room.votes.mid === room.media.uid
    ? room.votes.voters.filter((id) => room.users.some((u) => u.id === id)) : []);

  // ---------- session state ----------
  let peer = null;
  let isHost = false;
  let myId = null;
  let myName = '';
  let code = '';
  let hostConn = null;               // guest: connection to the host
  let pendingConnectFail = null;     // guest: called if the host can't be reached
  const guests = new Map();          // host: peerId -> { conn, name, lastSeen, joined, ready }
  let room = emptyRoom();
  let chat = [];
  let clockOffset = 0;               // hostClock - localClock, in ms
  let pongSamples = [];
  let lastPong = 0;
  let leaving = false;
  let connected = false;
  let migrating = false;

  function emptyRoom() {
    return {
      name: '', media: null, playing: false, pos: 0, at: 0, rate: 1, queue: [], users: [], share: null,
      owner: null, mods: [], settings: { ...DEFAULT_SETTINGS }, pass: null, banned: [], muted: [], allowed: [],
      votes: null, waiting: null,
    };
  }
  const hostNow = () => Date.now() + clockOffset;
  function expectedPos(r = room) {
    if (!r.media) return 0;
    if (!r.playing) return r.pos;
    return r.pos + Math.max(0, hostNow() - r.at) / 1000 * (r.rate || 1);
  }

  // ---------- helpers ----------
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  function clock(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function colorFor(str) {
    let h = 0;
    for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  function cleanRoomName(n) {
    return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  }
  function cleanName(n) {
    return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Guest';
  }
  const SOURCE = { youtube: 'YouTube', video: 'Video file', vimeo: 'Vimeo', twitch: 'Twitch', dailymotion: 'Dailymotion' };
  function mediaLabel(m) {
    return m.title || (m.kind === 'video' ? 'a video' : `a ${SOURCE[m.kind] || ''} video`);
  }
  const fallbackTitle = (m) => (m.kind === 'video' ? 'Video' : `${SOURCE[m.kind] || ''} video`);
  function genCode() {
    let c = '';
    const buf = new Uint32Array(6);
    crypto.getRandomValues(buf);
    for (const n of buf) c += CODE_CHARS[n % CODE_CHARS.length];
    return c;
  }
  function normCode(c) {
    return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  let toastTimer = null;
  function toast(text, ms = 2600) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- identity: a signing key that never leaves this browser ----------
  // Owner and moderator roles are tied to this key, so they survive host handovers and can't be
  // claimed by whoever happens to be relaying the room: joining means signing a one-time challenge.
  const ident = { uid: null, pub: null, key: null, ready: null };
  const enc = new TextEncoder();
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function b64uBytes(s) {
    const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  function randomToken(n = 16) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('watchroom', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idb(mode, fn) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function uidFor(pub) {
    return b64u(await crypto.subtle.digest('SHA-256', enc.encode(`${pub.x}.${pub.y}`))).slice(0, 16);
  }
  ident.ready = (async () => {
    try {
      let kp = await idb('readonly', (st) => st.get('identity'));
      if (!kp || !kp.privateKey || !kp.publicKey) {
        kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        await idb('readwrite', (st) => st.put(kp, 'identity'));
      }
      const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
      ident.pub = { x: jwk.x, y: jwk.y };
      ident.key = kp.privateKey;
      ident.uid = await uidFor(ident.pub);
    } catch { /* no identity in this browser: you join as a regular member */ }
  })();
  async function signNonce(nonce) {
    if (!ident.key) return null;
    return b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ident.key, enc.encode(nonce)));
  }
  async function verifyHello(d, nonce) {
    try {
      if (!d.pub || typeof d.pub.x !== 'string' || typeof d.pub.y !== 'string' || typeof d.sig !== 'string' || !nonce) return null;
      const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: d.pub.x, y: d.pub.y, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64uBytes(d.sig), enc.encode(nonce));
      return ok ? uidFor(d.pub) : null;
    } catch { return null; }
  }
  async function sha256hex(s) {
    const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function makePassHash(pw) {
    const salt = randomToken(16);
    return { salt, hash: await sha256hex(`${salt}:${pw}`) };
  }
  async function passwordMatches(pw) {
    if (!room.pass) return true;
    try { return (await sha256hex(`${room.pass.salt}:${String(pw).slice(0, 64)}`)) === room.pass.hash; } catch { return false; }
  }

  // ---------- link parsing ----------
  function parseTime(t) {
    if (!t) return 0;
    if (/^\d+$/.test(t)) return +t;
    const m = String(t).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
  }

  /** Turns pasted text into { kind, src, ytId?, start?, title? } or null. */
  function parseMedia(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    if (/^[\w-]{11}$/.test(s) && /[A-Z0-9_-]/.test(s)) {   // a bare video id ("programming" is a search)
      return { kind: 'youtube', ytId: s, src: `https://www.youtube.com/watch?v=${s}`, start: 0 };
    }
    if (/\s/.test(s)) return null;                     // words with spaces are a search, not a link
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    const isYT = host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com';
    // (Vimeo, Twitch and Dailymotion are handled after YouTube below.)
    if (isYT) {
      let id = null;
      if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
      else if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
        if (m) id = m[1];
      }
      const list = u.searchParams.get('list');
      if ((!id || !/^[\w-]{11}$/.test(id)) && list && /^[\w-]{10,64}$/.test(list)) {
        return { kind: 'ytplaylist', list, src: `https://www.youtube.com/playlist?list=${list}` };
      }
      if (!id || !/^[\w-]{11}$/.test(id)) return null;
      const start = parseTime(u.searchParams.get('t') || u.searchParams.get('start'));
      return { kind: 'youtube', ytId: id, src: `https://www.youtube.com/watch?v=${id}`, start, inList: !!list };
    }

    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const m = u.pathname.match(/(?:^|\/)(\d{5,12})(?:\/([a-f0-9]{6,20}))?(?:\/|$)/i);
      if (!m) return null;
      const hash = m[2] || u.searchParams.get('h') || '';
      const okHash = /^[a-f0-9]{6,20}$/i.test(hash) ? hash : '';
      const t = (u.hash.match(/t=([\dhms]+)/) || [])[1];
      return { kind: 'vimeo', vid: m[1], hash: okHash, src: `https://vimeo.com/${m[1]}${okHash ? '/' + okHash : ''}`, start: parseTime(t), title: '' };
    }

    if (host === 'twitch.tv' || host === 'player.twitch.tv' || host === 'clips.twitch.tv') {
      if (host === 'clips.twitch.tv' || /\/clip\//.test(u.pathname)) {
        return { kind: 'unsupported', reason: "Twitch clips can't be synced. Paste the full broadcast (twitch.tv/videos/…) or use Share a tab." };
      }
      const v = u.pathname.match(/^\/videos\/(\d{5,12})/) || (u.searchParams.get('video') || '').match(/^v?(\d{5,12})$/);
      if (v) return { kind: 'twitch', twVideo: v[1], src: `https://www.twitch.tv/videos/${v[1]}`, start: parseTime(u.searchParams.get('t')), title: `Twitch video ${v[1]}` };
      const ch = ((u.pathname.match(/^\/([a-z0-9_]{3,25})\/?$/i) || [])[1] || u.searchParams.get('channel') || '').toLowerCase();
      const reserved = ['directory', 'videos', 'settings', 'search', 'downloads', 'jobs', 'p', 'subscriptions', 'inventory', 'wallet', 'drops'];
      if (/^[a-z0-9_]{3,25}$/.test(ch) && !reserved.includes(ch)) {
        return { kind: 'twitch', twChannel: ch, live: true, src: `https://www.twitch.tv/${ch}`, start: 0, title: `${ch} (live on Twitch)` };
      }
      return null;
    }

    if (host === 'dailymotion.com' || host === 'dai.ly' || host === 'geo.dailymotion.com') {
      const id = (u.pathname.match(/\/video\/([a-z0-9]{5,12})/i) || [])[1]
        || (host === 'dai.ly' ? (u.pathname.match(/^\/([a-z0-9]{5,12})/i) || [])[1] : null)
        || u.searchParams.get('video');
      if (!id || !/^[a-z0-9]{5,12}$/i.test(id)) return null;
      return { kind: 'dailymotion', dmId: id, src: `https://www.dailymotion.com/video/${id}`, start: parseTime(u.searchParams.get('start')), title: '' };
    }

    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) return null;   // needs a real domain
    let file = u.pathname.split('/').pop() || u.hostname;
    try { file = decodeURIComponent(file); } catch { /* keep raw */ }
    return { kind: 'video', src: u.href, start: 0, title: file.slice(0, 200) };
  }

  // =====================================================================
  //  PLAYER — one interface over the YouTube iframe and a <video> element
  // =====================================================================
  const video = $('video-player');
  let ytApiPromise = null;
  function loadYouTubeApi() {
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { ytApiPromise = null; reject(new Error('YouTube API failed to load')); };
      document.head.appendChild(s);
    });
    return ytApiPromise;
  }

  // =====================================================================
  //  OTHER SITES — Vimeo, Twitch and Dailymotion players behind one small interface
  // =====================================================================
  const EXT_KINDS = ['vimeo', 'twitch', 'dailymotion'];
  const scriptCache = {};
  function loadScript(src, isReady) {
    if (isReady()) return Promise.resolve();
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = () => (isReady() ? resolve() : reject(new Error('script loaded without its player')));
        s.onerror = () => { delete scriptCache[src]; reject(new Error('script failed to load')); };
        document.head.appendChild(s);
      });
    }
    return scriptCache[src];
  }
  function freshExtHost() {
    const wrap = $('ext-wrap');
    wrap.textContent = '';
    const d = document.createElement('div');
    d.className = 'ext-host';
    d.id = `ext-${uid()}`;
    wrap.appendChild(d);
    return d;
  }
  /** Events from another site's player, treated like the YouTube/<video> ones. */
  function extEvent(type, t) {
    if (player.kind !== 'ext') return;
    if (type === 'ended') return onPlayerEnded();
    if (type === 'play') $('unmute-overlay').hidden = true;
    if (player.suppressed()) return;
    if (type === 'play') onLocalPlay(t);
    else if (type === 'pause') onLocalPause(t);
    else if (type === 'seek') onLocalSeek(t);
  }
  const autoplayBlocked = () => { if (room.playing && !player.errored) $('unmute-overlay').hidden = false; };

  /** Keeps a playback clock between the site's own (sometimes asynchronous) time reports. */
  function clock0() {
    return {
      t: 0, at: 0, playing: false, buffering: false,
      set(t) { if (typeof t === 'number' && isFinite(t)) { this.t = t; this.at = Date.now(); } },
      now() { return this.playing && !this.buffering ? this.t + (Date.now() - this.at) / 1000 : this.t; },
    };
  }

  function vimeoAdapter() {
    let p = null;
    let ready = false;
    let title = '';
    const c = clock0();
    return {
      async load(m, start) {
        await loadScript('https://player.vimeo.com/api/player.js', () => window.Vimeo && window.Vimeo.Player);
        const host = freshExtHost();
        p = new window.Vimeo.Player(host, { url: m.hash ? `https://vimeo.com/${m.vid}/${m.hash}` : `https://vimeo.com/${m.vid}`, autoplay: false, dnt: true, playsinline: true, width: 640 });
        p.on('timeupdate', (d) => c.set(d && d.seconds));
        p.on('play', () => { c.playing = true; extEvent('play', c.now()); });
        p.on('playing', () => { c.playing = true; c.buffering = false; });
        p.on('pause', (d) => { c.set(d && d.seconds); c.playing = false; extEvent('pause', c.now()); });
        p.on('seeked', (d) => { c.set(d && d.seconds); extEvent('seek', c.now()); });
        p.on('ended', () => { c.playing = false; extEvent('ended'); });
        p.on('bufferstart', () => { c.buffering = true; });
        p.on('bufferend', () => { c.buffering = false; });
        p.on('error', (e) => {
          if (e && (e.name === 'PrivacyError' || e.name === 'NotFoundError')) showStageError("This Vimeo video can't be played here. It may be private or not allowed on other sites.", m.src);
        });
        await p.ready();
        try { title = await p.getVideoTitle(); } catch { /* untitled */ }
        if (start > 0.5) { try { await p.setCurrentTime(start); } catch { /* past the end */ } }
        c.set(start || 0);
        ready = true;
      },
      play() { if (p) p.play().catch(autoplayBlocked); },
      pause() { if (p) p.pause().catch(() => {}); },
      seek(t) { c.set(t); if (p) p.setCurrentTime(t).catch(() => {}); },
      getTime: () => c.now(),
      isPlaying: () => c.playing,
      isBuffering: () => c.buffering,
      hasTime: () => ready,
      canPlayAt: () => ready && !c.buffering,
      title: () => title,
      destroy() { try { if (p) p.destroy(); } catch { /* gone */ } p = null; },
    };
  }

  function twitchAdapter() {
    let p = null;
    let ready = false;
    const c = clock0();
    const hms = (s) => { s = Math.floor(s); return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`; };
    const nowT = () => { try { return p.getCurrentTime() || 0; } catch { return c.now(); } };
    return {
      async load(m, start) {
        await loadScript('https://player.twitch.tv/js/embed/v1.js', () => window.Twitch && window.Twitch.Player);
        const host = freshExtHost();
        const opts = { width: '100%', height: '100%', parent: [location.hostname], autoplay: false, muted: false };
        if (m.twChannel) opts.channel = m.twChannel;
        else { opts.video = `v${m.twVideo}`; if (start > 1) opts.time = hms(start); }
        const E = window.Twitch.Player;
        p = new E(host.id, opts);
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('Twitch player timed out')), 15000);
          p.addEventListener(E.READY, () => { clearTimeout(t); resolve(); });
        });
        p.addEventListener(E.PLAY, () => { c.playing = true; c.buffering = true; extEvent('play', nowT()); });
        p.addEventListener(E.PLAYING, () => { c.playing = true; c.buffering = false; });
        p.addEventListener(E.PAUSE, () => { c.playing = false; c.buffering = false; extEvent('pause', nowT()); });
        p.addEventListener(E.ENDED, () => { c.playing = false; extEvent('ended'); });
        p.addEventListener(E.SEEK, (d) => extEvent('seek', d && typeof d.position === 'number' ? d.position : nowT()));
        if (E.PLAYBACK_BLOCKED) p.addEventListener(E.PLAYBACK_BLOCKED, autoplayBlocked);
        if (E.OFFLINE && m.twChannel) p.addEventListener(E.OFFLINE, () => showStageError(`${m.twChannel} isn't live on Twitch right now.`, m.src));
        ready = true;
      },
      play() { try { p.play(); } catch { /* not ready */ } },
      pause() { try { p.pause(); } catch { /* not ready */ } },
      seek(t) { try { p.seek(t); } catch { /* live */ } },
      getTime: () => (p ? nowT() : 0),
      isPlaying: () => { try { return !p.isPaused(); } catch { return c.playing; } },
      isBuffering: () => c.buffering,
      hasTime: () => ready,
      canPlayAt: () => ready,
      title: () => null,
      destroy() { p = null; $('ext-wrap').textContent = ''; },
    };
  }

  function dailymotionAdapter() {
    let p = null;
    let ready = false;
    let title = '';
    const c = clock0();
    const take = (s) => { if (s) { c.set(s.videoTime); if (s.videoTitle) title = s.videoTitle; } };
    return {
      async load(m, start) {
        if (!DM_PLAYER_ID) throw Object.assign(new Error('Dailymotion needs a Player ID'), { code: 'dm-config' });
        await loadScript(`https://geo.dailymotion.com/libs/player/${DM_PLAYER_ID}.js`, () => window.dailymotion && window.dailymotion.createPlayer);
        const host = freshExtHost();
        p = await window.dailymotion.createPlayer(host.id, { video: m.dmId, params: { startTime: Math.floor(start || 0), mute: false } });
        const E = window.dailymotion.events || {};
        const on = (name, fn) => { if (E[name]) p.on(E[name], fn); };
        on('VIDEO_TIMECHANGE', take);
        on('PLAYER_VIDEOCHANGE', take);
        on('VIDEO_PLAY', (s) => { take(s); c.playing = true; extEvent('play', c.now()); });
        on('VIDEO_PLAYING', (s) => { take(s); c.playing = true; c.buffering = false; });
        on('VIDEO_PAUSE', (s) => { take(s); c.playing = false; extEvent('pause', c.now()); });
        on('VIDEO_SEEKEND', (s) => { take(s); extEvent('seek', c.now()); });
        on('VIDEO_BUFFERING', () => { c.buffering = true; });
        on('VIDEO_END', () => { c.playing = false; extEvent('ended'); });
        on('PLAYER_ERROR', () => showStageError("Dailymotion couldn't play this video.", m.src));
        try { take(await p.getState()); } catch { /* no state yet */ }
        c.set(start || 0);
        ready = true;
      },
      play() { if (p) Promise.resolve(p.play()).catch(autoplayBlocked); },
      pause() { if (p) Promise.resolve(p.pause()).catch(() => {}); },
      seek(t) { c.set(t); if (p) Promise.resolve(p.seek(t)).catch(() => {}); },
      getTime: () => c.now(),
      isPlaying: () => c.playing,
      isBuffering: () => c.buffering,
      hasTime: () => ready,
      canPlayAt: () => ready && !c.buffering,
      title: () => title || null,
      destroy() { try { if (p && p.destroy) p.destroy(); } catch { /* gone */ } p = null; },
    };
  }

  const ADAPTERS = { vimeo: vimeoAdapter, twitch: twitchAdapter, dailymotion: dailymotionAdapter };

  const player = {
    ext: null,
    media: null,
    kind: null,
    ready: false,
    yt: null,
    ytCreated: false,
    hls: null,
    errored: false,
    suppressUntil: 0,
    lastTime: 0,
    lastTick: 0,
    lastFix: 0,
    loadToken: 0,

    suppress(ms = 900) { this.suppressUntil = Date.now() + ms; },
    suppressed() { return Date.now() < this.suppressUntil; },

    async load(media) {
      const token = ++this.loadToken;
      this.media = media;
      this.ready = false;
      this.errored = false;
      this.lastTick = 0;
      hideStageError();
      $('unmute-overlay').hidden = true;

      if (!media) {
        this.stopYouTube();
        this.stopVideo();
        this.destroyExt();
        $('yt-wrap').hidden = true;
        $('stage-empty').hidden = false;
        this.kind = null;
        return;
      }
      $('stage-empty').hidden = true;

      if (EXT_KINDS.includes(media.kind)) {
        this.stopVideo();
        this.stopYouTube();
        this.destroyExt();
        $('yt-wrap').hidden = true;
        $('ext-wrap').hidden = false;
        this.kind = 'ext';
        const adapter = ADAPTERS[media.kind]();
        this.ext = adapter;
        this.suppress(3000);
        try {
          await adapter.load(media, media.live ? 0 : expectedPos());
        } catch (e) {
          if (token !== this.loadToken) return;
          showStageError(e && e.code === 'dm-config'
            ? 'Dailymotion videos need a free Player ID set in js/config.js. The README explains how.'
            : `${SOURCE[media.kind]}'s player couldn't load. Check your connection or ad blocker, then reload.`, media.src);
          return;
        }
        if (token !== this.loadToken) { try { adapter.destroy(); } catch { /* gone */ } return; }
        this.ready = true;
        return;
      }
      this.destroyExt();
      $('ext-wrap').hidden = true;

      if (media.kind === 'youtube') {
        this.stopVideo();
        this.kind = 'youtube';
        $('yt-wrap').hidden = false;
        try {
          await loadYouTubeApi();
        } catch {
          if (token === this.loadToken) showStageError("YouTube's player couldn't load. Check your connection or ad blocker, then reload.");
          return;
        }
        if (token !== this.loadToken) return;
        await this.cueYouTube(media.ytId, expectedPos());
        if (token !== this.loadToken) return;
        this.ready = true;
      } else {
        this.stopYouTube();
        $('yt-wrap').hidden = true;
        this.kind = 'video';
        this.loadVideo(media);
        this.ready = true;
      }
    },

    destroyExt() {
      if (this.ext) { try { this.ext.destroy(); } catch { /* gone */ } this.ext = null; }
      $('ext-wrap').textContent = '';
      $('ext-wrap').hidden = true;
    },

    cueYouTube(videoId, start) {
      if (this.ytCreated && this.yt) {
        this.suppress(1500);
        this.yt.cueVideoById({ videoId, startSeconds: Math.max(0, start || 0) });
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        this.ytCreated = true;
        this.suppress(2500);
        this.yt = new YT.Player('yt-player', {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            playsinline: 1, rel: 0, modestbranding: 1, enablejsapi: 1,
            start: Math.floor(Math.max(0, start || 0)),
            origin: location.origin,
          },
          events: {
            onReady: () => resolve(),
            onStateChange: (e) => this.onYouTubeState(e.data),
            onError: (e) => this.onYouTubeError(e.data),
          },
        });
      });
    },

    onYouTubeState(s) {
      if (this.kind !== 'youtube') return;
      if (s === 0) return onPlayerEnded();
      if (s === 1) $('unmute-overlay').hidden = true;
      if (this.suppressed()) return;
      if (s === 1) onLocalPlay(this.getTime());
      else if (s === 2) onLocalPause(this.getTime());
    },

    onYouTubeError(code) {
      if (this.kind !== 'youtube') return;
      let msg = "YouTube couldn't play this video.";
      if (code === 101 || code === 150) {
        msg = "The owner of this video doesn't allow it to play on other sites. Age-restricted videos are blocked the same way. Open it on YouTube, or skip to the next one.";
      } else if (code === 100) {
        msg = 'This video was removed or is private.';
      } else if (code === 2) {
        msg = "That link doesn't point to a valid YouTube video.";
      } else if (code === 5) {
        msg = "This video can't be played in the embedded player.";
      }
      showStageError(msg, this.media && this.media.src);
    },

    stopYouTube() {
      if (this.yt && this.ytCreated) {
        try { this.yt.stopVideo(); } catch { /* not ready yet */ }
      }
    },

    loadVideo(m) {
      this.teardownHls();
      video.hidden = false;
      if (!/^https?:\/\//i.test(m.src)) return showStageError("That video link isn't valid.");
      const isHls = /\.m3u8(\?|#|$)/i.test(m.src);
      if (isHls && !video.canPlayType('application/vnd.apple.mpegurl') && window.Hls && window.Hls.isSupported()) {
        this.hls = new window.Hls();
        this.hls.on(window.Hls.Events.ERROR, (_e, data) => {
          if (data && data.fatal) showStageError("This stream couldn't be loaded. Check that the link opens in your browser.");
        });
        this.hls.loadSource(m.src);
        this.hls.attachMedia(video);
      } else {
        video.src = m.src;
      }
      this.suppress(1500);
    },

    teardownHls() {
      if (this.hls) { try { this.hls.destroy(); } catch { /* ignore */ } this.hls = null; }
    },

    stopVideo() {
      this.teardownHls();
      try { video.pause(); } catch { /* ignore */ }
      if (video.getAttribute('src')) {
        video.removeAttribute('src');
        video.load();
      }
      video.hidden = true;
    },

    play() {
      if (this.kind === 'ext' && this.ext) return this.ext.play();
      if (this.kind === 'youtube' && this.yt) {
        try { this.yt.playVideo(); } catch { /* ignore */ }
      } else if (this.kind === 'video') {
        const p = video.play();
        if (p && p.catch) p.catch(() => { if (room.playing && !this.errored) $('unmute-overlay').hidden = false; });
      }
    },
    pause() {
      if (this.kind === 'ext' && this.ext) return this.ext.pause();
      if (this.kind === 'youtube' && this.yt) { try { this.yt.pauseVideo(); } catch { /* ignore */ } }
      else if (this.kind === 'video') video.pause();
    },
    seek(t) {
      t = Math.max(0, t);
      // Remember our own seeks: on a slow connection they can finish long after we stop expecting them.
      this.lastSeekTarget = t;
      this.lastSeekAt = Date.now();
      if (this.kind === 'ext' && this.ext) this.ext.seek(t);
      else if (this.kind === 'youtube' && this.yt) { try { this.yt.seekTo(t, true); } catch { /* ignore */ } }
      else if (this.kind === 'video') { try { video.currentTime = t; } catch { /* not seekable yet */ } }
    },
    getTime() {
      if (this.kind === 'ext' && this.ext) return this.ext.getTime();
      if (this.kind === 'youtube' && this.yt && this.yt.getCurrentTime) {
        try { return this.yt.getCurrentTime() || 0; } catch { return 0; }
      }
      if (this.kind === 'video') return video.currentTime || 0;
      return 0;
    },
    state() {
      if (this.kind === 'youtube' && this.yt && this.yt.getPlayerState) {
        try { return this.yt.getPlayerState(); } catch { return -1; }
      }
      return -1;
    },
    isPlaying() {
      if (this.kind === 'ext') return !!(this.ext && this.ext.isPlaying());
      if (this.kind === 'youtube') { const s = this.state(); return s === 1 || s === 3; }
      if (this.kind === 'video') return !video.paused && !video.ended;
      return false;
    },
    /** Enough is loaded to play from `pos` (used to end a wait-for-buffering pause). */
    canPlayAt(pos) {
      if (this.kind === 'video') {
        if (video.readyState >= 3 && Math.abs(video.currentTime - pos) < 2) return true;
        const b = video.buffered;
        for (let i = 0; i < b.length; i++) if (b.start(i) <= pos + 0.5 && b.end(i) >= Math.min(pos + 3, (video.duration || Infinity) - 0.2)) return true;
        return false;
      }
      if (this.kind === 'youtube' && this.yt) {
        try {
          const s = this.state();
          if (s === 1) return true;
          if (s !== 2) return false;
          const d = this.yt.getDuration() || 0;
          const f = this.yt.getVideoLoadedFraction() || 0;
          return !d || f >= 0.99 || f * d >= pos + 3;
        } catch { return true; }
      }
      if (this.kind === 'ext' && this.ext) return this.ext.canPlayAt(pos);
      return true;
    },
    hasTime() {
      if (this.kind === 'ext') return !!(this.ext && this.ext.hasTime());
      if (this.kind === 'youtube') { const s = this.state(); return s === 1 || s === 2 || s === 3; }
      if (this.kind === 'video') return video.readyState >= 1;
      return false;
    },
    isBuffering() {
      if (this.kind === 'ext') return !!(this.ext && this.ext.isBuffering());
      if (this.kind === 'youtube') return this.state() === 3;
      if (this.kind === 'video') return video.readyState < 3 && !video.paused;
      return false;
    },
    title() {
      if (this.kind === 'ext') return this.ext ? this.ext.title() : null;
      if (this.kind === 'youtube' && this.yt && this.yt.getVideoData) {
        try { const d = this.yt.getVideoData(); return d && d.title; } catch { return null; }
      }
      return null;
    },
  };

  // <video> events (user interaction with native controls)
  video.addEventListener('play', () => {
    if (player.kind !== 'video') return;
    $('unmute-overlay').hidden = true;
    if (!player.suppressed()) onLocalPlay(video.currentTime);
  });
  video.addEventListener('pause', () => {
    if (player.kind !== 'video' || player.suppressed() || video.ended) return;
    onLocalPause(video.currentTime);
  });
  video.addEventListener('seeked', () => {
    if (player.kind !== 'video' || player.suppressed()) return;
    onLocalSeek(video.currentTime);
  });
  video.addEventListener('ended', () => { if (player.kind === 'video') onPlayerEnded(); });
  video.addEventListener('error', () => {
    if (player.kind !== 'video' || player.hls || !video.getAttribute('src')) return;
    showStageError("This video couldn't be loaded. The link has to point straight at a video file (.mp4, .webm) or an .m3u8 stream.");
  });

  function showStageError(text, ytLink) {
    player.errored = true;
    $('stage-error-text').textContent = text;
    const a = $('stage-error-link');
    if (ytLink && /^https:\/\//.test(ytLink)) {
      a.href = ytLink;
      const kind = player.media && player.media.kind;
      a.textContent = kind && SOURCE[kind] && kind !== 'video' ? `Open on ${SOURCE[kind]}` : 'Open the original';
      a.hidden = false;
    } else a.hidden = true;
    $('stage-error').hidden = false;
    $('unmute-overlay').hidden = true;
  }
  function hideStageError() { $('stage-error').hidden = true; }

  // ---------- keeping the local player in line with the room ----------
  function syncPlayer() {
    if (room.share) {
      // A live tab share replaces the player; keep the video paused underneath.
      if (player.ready && player.isPlaying()) { player.suppress(); player.pause(); }
      return;
    }
    const want = room.media;
    if (!want) {
      if (player.media) player.load(null);
      return;
    }
    if (!player.media || player.media.uid !== want.uid) {
      player.load(want).then(() => applyState(true));
      return;
    }
    applyState(false);
  }

  function applyState(fresh) {
    if (!player.ready || player.errored || !room.media || player.media.uid !== room.media.uid) return;
    const exp = expectedPos();
    const cur = player.getTime();
    const live = !!room.media.live;
    if (room.playing) {
      if (!live && ((fresh && Math.abs(cur - exp) > 0.5) || Math.abs(cur - exp) > DRIFT)) {
        player.suppress(); player.seek(exp); player.lastFix = Date.now();
      }
      if (!player.isPlaying()) {
        player.suppress(); player.play();
        checkBlockedSoon();
      }
    } else {
      if (player.isPlaying()) { player.suppress(); player.pause(); }
      if (fresh && player.kind === 'youtube' && !player.hasTime()) return;
      if (!live && Math.abs(cur - room.pos) > 0.5) {
        player.suppress();
        player.seek(room.pos);
        if (player.kind === 'youtube') {
          // seekTo on a cued YouTube video starts it; put it back to paused.
          setTimeout(() => {
            if (!room.playing && player.isPlaying()) { player.suppress(); player.pause(); }
          }, 400);
        }
      }
    }
  }

  function checkBlockedSoon() {
    const mid = room.media && room.media.uid;
    setTimeout(() => {
      if (room.share || room.waiting || !room.playing || !room.media || room.media.uid !== mid || player.errored || !player.ready) return;
      if (!player.isPlaying()) $('unmute-overlay').hidden = false;
    }, 2200);
  }

  $('unmute-overlay').addEventListener('click', () => {
    $('unmute-overlay').hidden = true;
    if (room.share && room.share.peer !== myId) {
      shareVideo.muted = false;
      shareVideo.play().catch(() => { /* still blocked */ });
      return;
    }
    if (player.kind === 'youtube' && player.yt) { try { player.yt.unMute(); } catch { /* ignore */ } }
    player.suppress();
    player.seek(expectedPos());
    player.play();
  });

  // Local user actions on the player become room actions.
  function onLocalPlay(t) {
    if (!room.media || room.playing) return;
    sendAction({ type: 'play', pos: t });
  }
  function onLocalPause(t) {
    if (!room.media) return;
    if (!room.playing) {
      if (Math.abs(t - room.pos) > 1) sendAction({ type: 'seek', pos: t });
      return;
    }
    sendAction({ type: 'pause', pos: t });
  }
  function onLocalSeek(t) {
    if (!room.media || room.media.live) return;
    if (Date.now() - (player.lastSeekAt || 0) < 20000 && Math.abs(t - player.lastSeekTarget) < 1.5) return;   // our own seek landing
    if (Math.abs(t - expectedPos()) < DRIFT + 0.5) return;
    sendAction({ type: 'seek', pos: t });
  }
  function onPlayerEnded() {
    if (!isHost || !room.media || !room.playing) return;
    handleAction(myId, { type: 'next', mid: room.media.uid, auto: true, pos: player.getTime() });
  }

  const reportedTitles = new Set();
  function tick() {
    if (room.share || room.waiting || (room.media && room.media.live)) return;
    if (!player.ready || player.errored || !room.media || !player.media || player.media.uid !== room.media.uid) return;
    const now = Date.now();
    const t = player.getTime();
    const playing = player.isPlaying();

    if (playing) $('unmute-overlay').hidden = true;

    if (!player.suppressed() && player.lastTick && player.hasTime()) {
      const dt = (now - player.lastTick) / 1000;
      const advanced = t - player.lastTime;
      const expectedAdvance = playing ? dt * (room.rate || 1) : 0;
      const jumped = Math.abs(advanced - expectedAdvance) > 2.5;

      if (jumped && player.kind === 'youtube') {
        // YouTube has no "seeked" event; a jump in time means the user scrubbed.
        onLocalSeek(t);
      } else if (room.playing && playing && !player.isBuffering() &&
                 Math.abs(t - expectedPos()) > DRIFT && now - player.lastFix > 4000) {
        player.suppress(700);
        player.seek(expectedPos());
        player.lastFix = now;
      } else if (!room.playing && !playing && Math.abs(t - room.pos) > 1.5) {
        onLocalSeek(t);
      }
    }
    player.lastTime = player.getTime();
    player.lastTick = now;

    // Pick up YouTube titles from the player when the host couldn't fetch them.
    const m = room.media;
    if (!m.titleSet && !reportedTitles.has(m.uid)) {
      const title = player.title();
      if (title) {
        reportedTitles.add(m.uid);
        if (isHost) setTitle(m.uid, title);
        else if (hostConn) hostConn.send({ t: 'title', mid: m.uid, title });
      }
    }
  }
  setInterval(tick, 500);

  // ---------- wait for buffering (everyone) ----------
  let bufSince = 0;
  let bufReported = false;
  let bufReportedAt = 0;
  let bufMid = null;
  let lastResume = 0;
  let wasPlaying = false;

  function reportBuffer(on) {
    bufReported = on;
    bufReportedAt = Date.now();
    bufMid = room.media ? room.media.uid : null;
    if (isHost) onBufferReport(myId, on, bufMid);
    else if (hostConn && hostConn.open) { try { hostConn.send({ t: 'buffer', on, mid: bufMid }); } catch { /* ignore */ } }
  }

  setInterval(() => {
    if (!myId || !room.media || room.share || room.media.live || !room.settings.waitBuffer) {
      if (bufReported) reportBuffer(false);
      bufSince = 0;
      return;
    }
    if (bufReported && bufMid !== room.media.uid) bufReported = false;   // a new video voids the old report
    const now = Date.now();
    if (room.playing && !wasPlaying) lastResume = now;
    wasPlaying = room.playing;
    const loading = !player.ready && !player.errored && player.media && player.media.uid === room.media.uid;
    const stalled = player.ready && !player.errored && player.isBuffering();
    if (room.playing) {
      if ((loading || stalled) && now - lastResume > 1500) {
        if (!bufSince) bufSince = now;
        if (!bufReported && now - bufSince > 700) reportBuffer(true);
      } else {
        bufSince = 0;
        if (bufReported) reportBuffer(false);
      }
    } else if (bufReported) {
      // The room paused for us: say we're ready once we can play from the paused spot.
      const ready = player.errored || (player.ready && (player.canPlayAt(room.pos) || (now - bufReportedAt > 6000 && !player.isBuffering())));
      if (ready) { bufSince = 0; reportBuffer(false); }
    }
  }, 300);

  // =====================================================================
  //  TAB SHARING — the sharer streams a tab straight to every viewer
  // =====================================================================
  const shareVideo = $('share-video');
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  let localShare = null;            // the MediaStream this browser is sending
  let myShareSid = null;            // the room's id for my current share, once the host confirms it
  let shareRequestedAt = 0;
  const outCalls = new Map();       // sharer: viewer peer id -> MediaConnection
  let viewCall = null;              // viewer: the call carrying the share
  let viewSid = null;
  let pendingCalls = [];            // calls that arrived before the room state named their sharer

  // Quality presets for the sharer. Each viewer gets their own copy, so upload ≈ kbps × viewers.
  const QUALITY = {
    smooth: { w: 1280, h: 720, fps: 30, kbps: 2500 },
    sharp: { w: 1920, h: 1080, fps: 30, kbps: 5000 },
    max: { w: 1920, h: 1080, fps: 60, kbps: 9000 },
  };
  const AUDIO_KBPS = 128;
  let qualityKey = QUALITY[store.get('watchroom-quality')] ? store.get('watchroom-quality') : 'sharp';
  const videoConstraints = (q) => ({
    width: { ideal: q.w, max: q.w }, height: { ideal: q.h, max: q.h }, frameRate: { ideal: q.fps, max: q.fps },
  });

  /** Moves one codec to the front of an m= line so both sides pick it when they can. */
  function preferCodec(sdp, kind, codec) {
    const lines = sdp.split(/\r\n/);
    const m = lines.findIndex((l) => l.startsWith(`m=${kind} `));
    if (m < 0) return sdp;
    let end = lines.findIndex((l, i) => i > m && l.startsWith('m='));
    if (end < 0) end = lines.length;
    const pts = [];
    const nameRe = new RegExp(`^a=rtpmap:(\\d+) ${codec}/`, 'i');
    for (let i = m + 1; i < end; i++) { const r = lines[i].match(nameRe); if (r) pts.push(r[1]); }
    if (!pts.length) return sdp;
    for (let i = m + 1; i < end; i++) {               // keep each codec's retransmission partner with it
      const r = lines[i].match(/^a=fmtp:(\d+) apt=(\d+)/);
      if (r && pts.includes(r[2])) pts.push(r[1]);
    }
    const parts = lines[m].split(' ');
    const list = parts.slice(3);
    const first = pts.filter((p) => list.includes(p));
    lines[m] = [...parts.slice(0, 3), ...first, ...list.filter((p) => !first.includes(p))].join(' ');
    return lines.join('\r\n');
  }

  /** Stereo, music-quality Opus instead of WebRTC's mono voice default. */
  function stereoOpus(sdp) {
    const r = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!r) return sdp;
    const pt = r[1];
    const want = ['stereo=1', 'sprop-stereo=1', `maxaveragebitrate=${AUDIO_KBPS * 1000}`, 'usedtx=0'];
    const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
    if (fmtp.test(sdp)) {
      return sdp.replace(fmtp, (_all, params) => {
        const keep = params.split(';').map((x) => x.trim()).filter((x) => x && !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx)=/i.test(x));
        return `a=fmtp:${pt} ${[...keep, ...want].join(';')}`;
      });
    }
    return sdp.replace(r[0], `${r[0]}\r\na=fmtp:${pt} ${want.join(';')}`);
  }

  // VP9 looks best per bit; with more viewers, H.264 is usually hardware-encoded and spares the CPU,
  // since every viewer means one more encoder running on the sharer's computer.
  const sdpFor = (codec) => (sdp) => stereoOpus(codec ? preferCodec(sdp, 'video', codec) : sdp);

  /** Applies the bitrate and frame-rate caps to one viewer's connection. Resolves true once applied. */
  async function tuneSenders(call) {
    const pc = call && call.peerConnection;
    if (!pc) return false;
    const q = QUALITY[qualityKey];
    let applied = false;
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) continue;   // not negotiated yet
      if (sender.track.kind === 'video') {
        p.encodings[0].maxBitrate = q.kbps * 1000;
        p.encodings[0].maxFramerate = q.fps;
      } else {
        p.encodings[0].maxBitrate = AUDIO_KBPS * 1000;
      }
      try { await sender.setParameters(p); applied = true; } catch { /* older browsers */ }
    }
    return applied;
  }

  function tuneWhenConnected(call) {
    let tries = 0;
    const t = setInterval(async () => {
      tries++;
      const pc = call.peerConnection;
      const up = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed');
      if ((up && await tuneSenders(call)) || tries > 30 || !outCalls.size) clearInterval(t);
    }, 1000);
  }

  async function setQuality(key) {
    if (!QUALITY[key]) return;
    qualityKey = key;
    store.set('watchroom-quality', key);
    const vt = localShare && localShare.getVideoTracks()[0];
    if (vt) { try { await vt.applyConstraints(videoConstraints(QUALITY[key])); } catch { /* keeps the old size */ } }
    for (const c of outCalls.values()) tuneSenders(c);
    renderShareControls();
  }

  function renderShareControls() {
    $('share-controls').hidden = !localShare;
    if (!localShare) return;
    $('share-quality').value = qualityKey;
    const viewers = room.users.filter((u) => u.id && u.id !== myId).length;
    const mbps = (viewers * (QUALITY[qualityKey].kbps + AUDIO_KBPS)) / 1000;
    $('share-upload').textContent = viewers
      ? `Needs about ${mbps < 10 ? mbps.toFixed(1) : Math.round(mbps)} Mbps upload for ${viewers} ${viewers === 1 ? 'person' : 'people'}.${qualityKey === 'smooth' ? '' : ' Pick Smooth if it stutters.'}`
      : 'Nobody else is watching yet.';
  }
  $('share-quality').addEventListener('change', (e) => setQuality(e.target.value));

  // Show viewers the resolution actually arriving.
  shareVideo.addEventListener('resize', () => {
    const h = shareVideo.videoHeight;
    $('share-res').textContent = h ? `${h}p` : '';
  });

  async function startShare() {
    if (!canShare) {
      toast('Sharing needs Chrome, Edge or Firefox on a computer. You can still watch shares on this device.', 5000);
      return;
    }
    const btn = $('share-btn');
    btn.disabled = true;
    btn.textContent = 'Choose a tab…';
    let stream;
    try {
      stream = await pickDisplay();
    } catch (e) {
      shareStartError(e);
      return;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Share a tab';
    }
    if (localShare) stopLocalShare();
    localShare = stream;
    myShareSid = null;
    shareRequestedAt = Date.now();
    const vt = stream.getVideoTracks()[0];
    if (vt) {
      try { vt.contentHint = 'motion'; } catch { /* older browsers */ }
      vt.addEventListener('ended', () => { if (localShare === stream) endMyShare(); });
    }
    if (!stream.getAudioTracks().length) {
      toast('No sound is being shared. To include sound, stop, then share a Chrome or Edge tab with "Share tab audio" on.', 7000);
    }
    sendAction({ type: 'shareStart' });
    renderShare();
  }

  async function pickDisplay() {
    const rich = {
      video: videoConstraints(QUALITY[qualityKey]),
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'include',
    };
    const startedAt = Date.now();
    try {
      return await navigator.mediaDevices.getDisplayMedia(rich);
    } catch (e) {
      e.fastFail = Date.now() - startedAt < 600;
      // Some browsers reject options they don't know; try once with the basics.
      if (e && (e.name === 'TypeError' || e.name === 'OverconstrainedError' || e.name === 'NotSupportedError')) {
        return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      }
      throw e;
    }
  }

  function shareStartError(e) {
    const name = (e && e.name) || 'Error';
    const msg = String((e && e.message) || '');
    if (name === 'NotAllowedError' && /system/i.test(msg)) {
      toast('Your computer is blocking screen sharing for this browser. On a Mac, turn your browser on in System Settings → Privacy & Security → Screen Recording, then restart it.', 10000);
    } else if ((name === 'NotAllowedError' || name === 'AbortError') && e.fastFail) {
      toast('Your browser blocked the share window. Click the icon at the left of the address bar, allow screen sharing for this site, then try again.', 9000);
    } else if (name === 'NotAllowedError' || name === 'AbortError') {
      // The person closed the picker; nothing to report.
    } else {
      toast(`Couldn't start sharing (${name}${msg ? ': ' + msg : ''}). Try Chrome or Edge on a computer.`, 9000);
    }
  }

  function endMyShare() {
    const sid = room.share && room.share.peer === myId ? room.share.sid : myShareSid;
    stopLocalShare();
    if (sid) sendAction({ type: 'shareStop', sid });
  }

  function stopLocalShare() {
    for (const c of outCalls.values()) { try { c.close(); } catch { /* ignore */ } }
    outCalls.clear();
    if (localShare) {
      localShare.getTracks().forEach((t) => t.stop());
      localShare = null;
    }
    myShareSid = null;
    if (shareVideo.srcObject && !viewCall) shareVideo.srcObject = null;
    renderShare();
  }

  function onIncomingCall(call) {
    const sid = call.metadata && call.metadata.sid;
    const s = room.share;
    if (s && s.peer !== myId && call.peer === s.peer && sid === s.sid) return answerCall(call);
    call._at = Date.now();
    pendingCalls.push(call);
  }

  function answerCall(call) {
    closeView();
    viewCall = call;
    viewSid = call.metadata && call.metadata.sid;
    call.on('stream', (stream) => {
      if (viewCall !== call) return;
      shareVideo.srcObject = stream;
      shareVideo.muted = false;
      const p = shareVideo.play();
      if (p && p.catch) {
        p.catch(() => {
          // Autoplay with sound was refused: play muted and offer sound on tap.
          shareVideo.muted = true;
          shareVideo.play().catch(() => { /* ignore */ });
          $('unmute-text').textContent = 'Turn on sound';
          $('unmute-overlay').classList.add('is-compact');
          $('unmute-overlay').hidden = false;
        });
      }
      renderShare();
    });
    const gone = () => {
      if (viewCall !== call) return;
      viewCall = null;
      viewSid = null;
      shareVideo.srcObject = null;
      renderShare();
    };
    call.on('close', gone);
    call.on('error', gone);
    call.answer(undefined, { sdpTransform: sdpFor(null) });
  }

  function closeView() {
    if (viewCall) {
      const c = viewCall;
      viewCall = null;
      viewSid = null;
      try { c.close(); } catch { /* ignore */ }
    }
    if (!localShare) shareVideo.srcObject = null;
  }

  /** Brings calls in line with the room: who should receive my share, and which share I should watch. */
  function reconcileShare() {
    const s = room.share;

    // Sharer side
    if (localShare) {
      if (s && s.peer === myId) {
        myShareSid = s.sid;
        const want = new Set(room.users.map((u) => u.id).filter((id) => id && id !== myId));
        for (const [id, c] of outCalls) {
          if (!want.has(id) || c._sid !== s.sid) { try { c.close(); } catch { /* ignore */ } outCalls.delete(id); }
        }
        for (const id of want) {
          if (outCalls.has(id) || !peer || peer.destroyed || peer.disconnected) continue;
          const codec = want.size <= 2 ? 'VP9' : 'H264';
          const c = peer.call(id, localShare, { metadata: { sid: s.sid }, sdpTransform: sdpFor(codec) });
          if (!c) continue;
          c._sid = s.sid;
          outCalls.set(id, c);
          tuneWhenConnected(c);
          const drop = () => { if (outCalls.get(id) === c) outCalls.delete(id); };
          c.on('close', drop);
          c.on('error', drop);
        }
      } else if (myShareSid && (!s || s.sid !== myShareSid)) {
        stopLocalShare();
        toast(s ? `${s.name} started sharing, so your share ended.` : 'Your tab share ended.', 4000);
      } else if (!myShareSid && Date.now() - shareRequestedAt > 12000) {
        stopLocalShare();
        toast("The room didn't start your share. Try again.", 4000);
      }
    }

    // Viewer side
    if (s && s.peer !== myId) {
      if (viewCall && viewSid !== s.sid) closeView();
      if (!viewCall) {
        const i = pendingCalls.findIndex((c) => c.peer === s.peer && c.metadata && c.metadata.sid === s.sid);
        if (i >= 0) answerCall(pendingCalls.splice(i, 1)[0]);
      }
    } else if (viewCall) {
      closeView();
    }

    const now = Date.now();
    pendingCalls = pendingCalls.filter((c) => {
      if (now - c._at < 10000) return true;
      try { c.close(); } catch { /* ignore */ }
      return false;
    });
  }
  setInterval(() => { if (myId) reconcileShare(); }, 4000);

  function renderShare() {
    const s = room.share;
    const mine = !!(s && s.peer === myId);
    $('stage').classList.toggle('is-sharing', !!s);
    $('share-layer').hidden = !s;

    if (s) {
      $('share-who').textContent = mine ? 'You are sharing' : `${s.name} is sharing`;
      if (mine && localShare) {
        if (shareVideo.srcObject !== localShare) shareVideo.srcObject = localShare;
        shareVideo.muted = true;           // you already hear the tab itself
        shareVideo.controls = false;
        shareVideo.play().catch(() => { /* preview only */ });
      } else {
        shareVideo.controls = true;
      }
      const waiting = !shareVideo.srcObject;
      $('share-wait').hidden = !waiting;
      if (waiting) $('share-wait').textContent = mine ? 'Starting your share…' : `Connecting to ${s.name}'s tab…`;
    } else {
      $('share-wait').hidden = true;
      if (!localShare && shareVideo.srcObject) shareVideo.srcObject = null;
      if ($('unmute-overlay').classList.contains('is-compact')) {
        $('unmute-overlay').hidden = true;
        $('unmute-overlay').classList.remove('is-compact');
        $('unmute-text').textContent = 'Tap to join playback';
      }
    }

    if (!shareVideo.srcObject || mine) $('share-res').textContent = mine && shareVideo.videoHeight ? `${shareVideo.videoHeight}p` : '';
    renderShareControls();
    $('share-btn').hidden = !!localShare || !canShare;   // phones can watch shares but not start them
    $('stop-share-btn').hidden = !localShare;
    $('share-btn').title = 'Stream one of your browser tabs to the room';
    $('share-hint').hidden = !!s || !canShare;
  }

  $('share-btn').addEventListener('click', startShare);
  $('stop-share-btn').addEventListener('click', endMyShare);

  // =====================================================================
  //  HOST — owns the room state
  // =====================================================================
  function nameOf(id) {
    if (id === myId) return myName;
    const g = guests.get(id);
    return g ? g.name : 'Someone';
  }

  function roleOfUid(u) {
    if (!u) return 'member';
    if (u === room.owner) return 'owner';
    return room.mods.includes(u) ? 'mod' : 'member';
  }
  function uidOfPeer(id) {
    if (id === myId) return ident.uid;
    const g = guests.get(id);
    return (g && g.uid) || null;
  }
  const roleOfPeer = (id) => roleOfUid(uidOfPeer(id));

  function rebuildUsers() {
    const entry = (id, name, u, host, anonMuted) => ({
      id, name, host, uid: u || null, role: roleOfUid(u), muted: !!((u && room.muted.includes(u)) || anonMuted),
    });
    const list = [entry(myId, myName, ident.uid, true, false)];
    [...guests.entries()]
      .filter(([, g]) => g.ready)
      .sort((a, b) => a[1].joined - b[1].joined)
      .forEach(([id, g]) => list.push(entry(id, g.name, g.uid, false, g.mutedAnon)));
    room.users = list;
  }

  /** A message for one person, from the room (refusals, warnings). */
  function tellPeer(id, text) {
    if (id === myId) return toast(text, 4000);
    const g = guests.get(id);
    if (g && g.conn.open) { try { g.conn.send({ t: 'notice', text }); } catch { /* gone */ } }
  }
  /** Puts someone's player back in line after a refused action. */
  function resyncPeer(id) {
    if (id === myId) { render(); syncPlayer(); return; }
    const g = guests.get(id);
    if (g && g.conn.open) { try { g.conn.send({ t: 'state', room }); } catch { /* gone */ } }
  }

  function setMedia(m) {
    room.votes = null;
    room.waiting = null;
    room.media = m;
    room.pos = m.start || 0;
    room.at = hostNow();
    room.playing = true;
  }

  function hostMediaFrom(a, by) {
    const m = parseMedia(a && a.media && a.media.raw);
    if (!m || m.kind === 'unsupported' || m.kind === 'ytplaylist') return null;
    if (m.kind === 'dailymotion' && !DM_PLAYER_ID) return null;
    m.uid = uid();
    m.by = cleanName(by);
    m.titleSet = m.kind === 'video' || m.kind === 'twitch';
    const given = a.media && typeof a.media.title === 'string' ? a.media.title.trim() : '';
    if (given) { m.title = given.slice(0, 200); m.titleSet = true; }
    else if (['youtube', 'vimeo', 'dailymotion'].includes(m.kind)) fetchTitle(m);
    return m;
  }

  function handleAction(from, a) {
    if (!a || typeof a !== 'object') return;
    const who = nameOf(from);
    const cur = room.media;
    const pos = Math.max(0, Number(a.pos) || 0);

    if (['play', 'pause', 'seek'].includes(a.type) && (!cur || a.mid !== cur.uid)) return;

    // Who may do this?
    const mod = roleOfPeer(from) !== 'member';
    const S = room.settings;
    const refuse = (text) => { tellPeer(from, text); resyncPeer(from); };
    const PLAYBACK = ['play', 'pause', 'seek', 'load', 'loadMany', 'playNow', 'remove', 'up', 'shareStart'];
    if (PLAYBACK.includes(a.type) && S.playback === 'mods' && !mod) return refuse('Only moderators can control playback in this room.');
    if ((a.type === 'enqueue' || a.type === 'enqueueMany') && S.adding === 'mods' && !mod) return refuse('Only moderators can add videos in this room.');
    if (a.type === 'next') {
      if (a.auto && from !== myId) return;
      if (!a.auto && !mod) {
        if (S.playback === 'mods') return refuse('Only moderators can skip in this room.');
        if (S.skip === 'vote') return castVote(from, who);
      }
    }
    if (MOD_ACTIONS.includes(a.type)) {
      if (!mod) return refuse('Only moderators can do that.');
      return modAction(from, who, a);
    }

    switch (a.type) {
      case 'play':
        room.pos = pos; room.at = hostNow(); room.playing = true; room.waiting = null; buffering.clear();
        systemMsg(`${who} pressed play`);
        break;
      case 'pause':
        room.pos = pos; room.at = hostNow(); room.playing = false; room.waiting = null;
        systemMsg(`${who} paused at ${fmt(pos)}`);
        break;
      case 'seek':
        room.pos = pos; room.at = hostNow();
        systemMsg(`${who} jumped to ${fmt(pos)}`);
        break;
      case 'load': {
        const m = hostMediaFrom(a, who);
        if (!m) return;
        room.share = null;
        setMedia(m);
        systemMsg(`${who} started ${mediaLabel(m)}`);
        break;
      }
      case 'enqueue': {
        const m = hostMediaFrom(a, who);
        if (!m) return;
        if (!room.media) { room.share = null; setMedia(m); systemMsg(`${who} started ${mediaLabel(m)}`); }
        else if (room.queue.length < MAX_QUEUE) { room.queue.push(m); systemMsg(`${who} queued ${mediaLabel(m)}`); }
        else return;
        break;
      }
      case 'next': {
        if (a.mid && (!cur || a.mid !== cur.uid)) return;
        doNext(who, !!a.auto, pos);
        break;
      }
      case 'loadMany':
      case 'enqueueMany': {
        const items = Array.isArray(a.items) ? a.items.slice(0, MAX_QUEUE) : [];
        const ms = items.map((it) => hostMediaFrom({ media: it }, who)).filter(Boolean);
        if (!ms.length) return;
        const total = ms.length;
        if (a.type === 'loadMany' || !room.media) { room.share = null; setMedia(ms.shift()); }
        const room_left = Math.max(0, MAX_QUEUE - room.queue.length);
        const added = ms.slice(0, room_left);
        room.queue = a.type === 'loadMany' ? [...added, ...room.queue].slice(0, MAX_QUEUE) : [...room.queue, ...added];
        systemMsg(`${who} added ${total} videos from a playlist`);
        break;
      }
      case 'playNow': {
        const i = room.queue.findIndex((q) => q.uid === a.uid);
        if (i < 0) return;
        const [m] = room.queue.splice(i, 1);
        room.share = null;
        setMedia(m);
        systemMsg(`${who} started ${mediaLabel(m)}`);
        break;
      }
      case 'up': {
        const i = room.queue.findIndex((q) => q.uid === a.uid);
        if (i <= 0) return;
        [room.queue[i - 1], room.queue[i]] = [room.queue[i], room.queue[i - 1]];
        break;
      }
      case 'shareStart':
        room.share = { peer: from, name: who, sid: uid() };
        if (room.media && room.playing) { room.pos = expectedPos(); room.at = hostNow(); room.playing = false; }
        systemMsg(`${who} started sharing a tab`);
        break;
      case 'shareStop':
        if (!room.share || a.sid !== room.share.sid) return;
        room.share = null;
        systemMsg(`${who} stopped sharing`);
        break;
      case 'remove': {
        const before = room.queue.length;
        room.queue = room.queue.filter((q) => q.uid !== a.uid);
        if (room.queue.length === before) return;
        break;
      }
      default:
        return;
    }
    broadcastState();
  }

  function doNext(who, auto, pos) {
    const cur = room.media;
    if (!auto) room.share = null;
    const next = room.queue.shift();
    if (next) {
      setMedia(next);
      if (!auto) systemMsg(`${who} skipped to ${mediaLabel(next)}`);
    } else if (auto && cur) {
      room.playing = false; room.pos = pos || room.pos; room.at = hostNow();
    } else {
      room.votes = null;
      room.media = null; room.playing = false; room.pos = 0; room.at = hostNow();
      if (cur) systemMsg(`${who} cleared the player`);
    }
  }

  function castVote(from, who) {
    const cur = room.media;
    if (!cur) return;
    if (!room.votes || room.votes.mid !== cur.uid) room.votes = { mid: cur.uid, voters: [] };
    if (!room.votes.voters.includes(from)) {
      room.votes.voters.push(from);
      systemMsg(`${who} voted to skip (${liveVoters().length}/${votesNeeded()})`);
    }
    if (!checkVotes()) broadcastState();
  }
  /** Skips when a majority of the people here voted. Returns true if it skipped (and broadcast). */
  function checkVotes() {
    if (!room.votes || !room.media || room.votes.mid !== room.media.uid) return false;
    if (liveVoters().length < votesNeeded()) return false;
    systemMsg('The vote passed, skipping');
    doNext('The room', false, 0);
    broadcastState();
    return true;
  }

  // ---------- wait for buffering (host) ----------
  const buffering = new Map();      // peer id -> when they started loading
  const bufferIgnore = new Map();   // peer id -> don't wait for them again before this time
  const bufferStrikes = new Map();  // peer id -> times they made the room wait recently
  let waitSince = 0;
  const WAIT_LIMIT = 12000;

  function onBufferReport(from, on, mid) {
    if (!room.media || mid !== room.media.uid) return;
    if (!on) buffering.delete(from);
    else if (room.settings.waitBuffer && !room.share && !room.media.live && (bufferIgnore.get(from) || 0) < Date.now()) buffering.set(from, Date.now());
    evaluateWait();
  }
  function evaluateWait() {
    for (const id of [...buffering.keys()]) if (!room.users.some((u) => u.id === id)) buffering.delete(id);
    if (buffering.size && room.playing && !room.waiting) {
      // Someone who keeps falling behind stops holding the room up for a minute.
      const now = Date.now();
      for (const id of [...buffering.keys()]) {
        const recent = (bufferStrikes.get(id) || []).filter((t) => now - t < 60000);
        recent.push(now);
        bufferStrikes.set(id, recent);
        if (recent.length > 3) {
          buffering.delete(id);
          bufferIgnore.set(id, now + 60000);
          bufferStrikes.delete(id);
          tellPeer(id, "Your connection keeps falling behind, so the room won't wait for you for a minute.");
          systemMsg(`Not waiting for ${nameOf(id)} for a minute: their connection keeps falling behind`);
        }
      }
    }
    const names = [...buffering.keys()].map(nameOf);
    if (names.length && room.playing && !room.waiting) {
      room.pos = expectedPos(); room.at = hostNow(); room.playing = false; room.waiting = names; waitSince = Date.now();
      broadcastState();
    } else if (room.waiting) {
      if (!names.length) resumeAfterWait();
      else if (names.join('|') !== room.waiting.join('|')) { room.waiting = names; broadcastState(); }
    }
  }
  function resumeAfterWait() {
    room.waiting = null;
    room.playing = true;
    room.at = hostNow();
    broadcastState();
  }
  setInterval(() => {
    if (!isHost || !room.waiting || Date.now() - waitSince < WAIT_LIMIT) return;
    for (const id of buffering.keys()) bufferIgnore.set(id, Date.now() + 30000);
    buffering.clear();
    systemMsg(`Not waiting any longer for ${room.waiting.join(', ')}`);
    resumeAfterWait();
  }, 1000);

  const MOD_ACTIONS = ['setting', 'setPassword', 'clearPassword', 'kick', 'unban', 'mute', 'unmute', 'mod', 'unmod'];
  const SETTING_TEXT = {
    playback: { all: 'everyone can control playback', mods: 'only moderators can control playback' },
    adding: { all: 'everyone can add videos', mods: 'only moderators can add videos' },
    chat: { all: 'everyone can chat', mods: 'only moderators can chat' },
    skip: { instant: 'skipping is instant', vote: 'skipping needs a vote' },
    waitBuffer: { true: 'the room waits for anyone loading', false: "the room doesn't wait for loading" },
  };

  async function modAction(from, who, a) {
    const actor = roleOfPeer(from);
    const target = a.target ? room.users.find((u) => u.id === a.target) : null;
    // Owners act on anyone but themselves; moderators act on regular members only.
    const canTouch = target && target.id !== from && target.role !== 'owner' && (actor === 'owner' || target.role === 'member');
    switch (a.type) {
      case 'setting': {
        if (!SETTING_VALUES[a.key] || !SETTING_VALUES[a.key].includes(a.value)) return;
        room.settings = { ...room.settings, [a.key]: a.value };
        if (a.key === 'skip') room.votes = null;
        if (a.key === 'waitBuffer' && !a.value) { buffering.clear(); if (room.waiting) resumeAfterWait(); }
        systemMsg(`${who} changed the rules: ${SETTING_TEXT[a.key][String(a.value)]}`);
        break;
      }
      case 'setPassword': {
        const pw = String(a.password || '').slice(0, 64);
        if (!pw) return;
        room.pass = await makePassHash(pw);
        // Everyone already inside can come back without typing it.
        room.allowed = [...new Set(room.users.map((u) => u.uid).filter(Boolean))].slice(-200);
        systemMsg(`${who} set a room password`);
        break;
      }
      case 'clearPassword':
        if (!room.pass) return;
        room.pass = null;
        systemMsg(`${who} removed the room password`);
        break;
      case 'kick': {
        if (!canTouch) return tellPeer(from, "You can't remove that person.");
        if (target.uid && !room.banned.some((b) => b.uid === target.uid)) room.banned.push({ uid: target.uid, name: target.name });
        if (target.uid) room.allowed = room.allowed.filter((x) => x !== target.uid);
        systemMsg(`${who} removed ${target.name} from the room`);
        if (target.id === myId) {
          // The person relaying the room was removed: hand the room on and leave.
          broadcastState();
          setTimeout(() => leaveWithNotice('A moderator removed you from this room.'), 300);
          return;
        }
        removePeer(target.id, 'kicked');
        break;
      }
      case 'unban': {
        const b = room.banned.find((x) => x.uid === a.uid);
        if (!b) return;
        room.banned = room.banned.filter((x) => x.uid !== a.uid);
        systemMsg(`${who} let ${b.name} back in`);
        break;
      }
      case 'mute':
      case 'unmute': {
        if (!canTouch) return tellPeer(from, "You can't mute that person.");
        const on = a.type === 'mute';
        if (target.uid) room.muted = on ? [...new Set([...room.muted, target.uid])] : room.muted.filter((x) => x !== target.uid);
        else { const g = guests.get(target.id); if (g) g.mutedAnon = on; }
        systemMsg(`${who} ${on ? 'muted' : 'unmuted'} ${target.name}`);
        break;
      }
      case 'mod':
      case 'unmod': {
        if (actor !== 'owner') return tellPeer(from, 'Only the room owner can choose moderators.');
        if (!target || target.role === 'owner') return;
        if (!target.uid) return tellPeer(from, `${target.name}'s browser can't hold a role. They need a recent Chrome, Edge, Firefox or Safari.`);
        const on = a.type === 'mod';
        room.mods = on ? [...new Set([...room.mods, target.uid])] : room.mods.filter((x) => x !== target.uid);
        systemMsg(on ? `${who} made ${target.name} a moderator` : `${target.name} is no longer a moderator`);
        break;
      }
      default:
        return;
    }
    broadcastState();
  }

  function removePeer(id, reason) {
    const g = guests.get(id);
    if (!g) return;
    try { g.conn.send({ t: 'denied', reason }); } catch { /* gone */ }
    guests.delete(id);
    if (room.share && room.share.peer === id) room.share = null;
    setTimeout(() => { try { g.conn.close(); } catch { /* ignore */ } }, 400);
  }

  // Look titles up a few at a time (a playlist can add a hundred at once).
  const titleQueue = [];
  let titlesActive = 0;
  function fetchTitle(m) { titleQueue.push(m); pumpTitles(); }
  function pumpTitles() {
    while (titlesActive < 3 && titleQueue.length) {
      const m = titleQueue.shift();
      titlesActive++;
      fetchTitleNow(m).finally(() => { titlesActive--; pumpTitles(); });
    }
  }
  async function fetchTitleNow(m) {
    try {
      const r = await fetch('https://noembed.com/embed?url=' + encodeURIComponent(m.src));
      const j = await r.json();
      if (j && typeof j.title === 'string' && j.title) setTitle(m.uid, j.title);
    } catch { /* the player will report the title instead */ }
  }

  function setTitle(mediaUid, title) {
    if (!isHost) return;
    const target = (room.media && room.media.uid === mediaUid) ? room.media : room.queue.find((q) => q.uid === mediaUid);
    if (!target || target.titleSet) return;
    target.title = String(title).slice(0, 200);
    target.titleSet = true;
    broadcastState();
  }

  function broadcastState() {
    rebuildUsers();
    const msg = { t: 'state', room };
    for (const g of guests.values()) {
      if (g.ready && g.conn.open) { try { g.conn.send(msg); } catch { /* dropped */ } }
    }
    render();
    syncPlayer();
  }

  function pushChat(m) {
    chat.push(m);
    if (chat.length > MAX_CHAT) chat = chat.slice(-MAX_CHAT);
    appendChat(m);
    if (isHost) {
      const msg = { t: 'chat', m };
      for (const g of guests.values()) {
        if (g.ready && g.conn.open) { try { g.conn.send(msg); } catch { /* dropped */ } }
      }
    }
  }
  function systemMsg(text) {
    if (!isHost) return;
    pushChat({ system: true, text, ts: Date.now() });
  }

  function onGuestConnection(conn) {
    conn.on('open', () => {
      const nonce = `${randomToken(16)}:${code}`;
      guests.set(conn.peer, { conn, name: 'Guest', lastSeen: Date.now(), joined: Date.now(), ready: false, nonce });
      try { conn.send({ t: 'challenge', nonce }); } catch { /* closed */ }
    });
    conn.on('data', (d) => {
      if (!d || typeof d !== 'object') return;
      const g = guests.get(conn.peer);
      if (!g) return;
      g.lastSeen = Date.now();
      switch (d.t) {
        case 'hello':
          if (g.ready || g.checking) return;
          g.checking = true;
          admitGuest(conn, g, d);
          break;
        case 'ping':
          conn.send({ t: 'pong', c: d.c, h: Date.now() });
          break;
        case 'peek':
          // A lobby checking who's here. Answer and hang up; it never joins.
          if (g.ready) return;
          conn.send(room.pass
            ? { t: 'peekInfo', name: room.name, private: true, count: room.users.length }
            : {
              t: 'peekInfo',
              name: room.name,
              users: room.users.map((u) => ({ name: u.name })),
              now: room.share ? '' : (room.media ? (room.media.title || '') : ''),
              share: !!room.share,
            });
          guests.delete(conn.peer);
          setTimeout(() => { try { conn.close(); } catch { /* ignore */ } }, 800);
          break;
        case 'action':
          if (g.ready) handleAction(conn.peer, d.a);
          break;
        case 'chat': {
          const text = String(d.text || '').trim().slice(0, 400);
          if (!g.ready || !text) break;
          const why = chatBlocked(conn.peer);
          if (why) { tellPeer(conn.peer, why); break; }
          pushChat({ from: conn.peer, name: g.name, text, ts: Date.now() });
          break;
        }
        case 'title':
          if (typeof d.title === 'string' && d.title) setTitle(d.mid, d.title);
          break;
        case 'buffer':
          if (g.ready) onBufferReport(conn.peer, !!d.on, d.mid);
          break;
        case 'prove':
          if (g.ready && !g.uid) upgradeGuest(conn, g, d);
          break;
        case 'bye':
          dropGuest(conn.peer);
          break;
        default:
          break;
      }
    });
    conn.on('close', () => dropGuest(conn.peer));
    conn.on('error', () => dropGuest(conn.peer));
  }

  async function admitGuest(conn, g, d) {
    const u = await verifyHello(d, g.nonce);
    if (guests.get(conn.peer) !== g) return;           // left while we checked
    if (u && room.banned.some((b) => b.uid === u)) return removePeer(conn.peer, 'kicked');
    const trusted = u && (u === room.owner || room.mods.includes(u) || room.allowed.includes(u));
    if (room.pass && !trusted) {
      if (!d.pass) return removePeer(conn.peer, 'password');
      if (!(await passwordMatches(d.pass))) return removePeer(conn.peer, 'wrong-password');
      if (guests.get(conn.peer) !== g) return;
    }
    g.uid = u;
    g.name = cleanName(d.name);
    g.ready = true;
    g.checking = false;
    if (u && !room.allowed.includes(u)) room.allowed = [...room.allowed, u].slice(-200);
    rebuildUsers();
    conn.send({ t: 'welcome', you: conn.peer, chat: chat.slice(-100) });
    systemMsg(`${g.name} joined`);
    broadcastState();
  }

  /** Someone who joined before our challenge reached them proves their identity afterwards. */
  async function upgradeGuest(conn, g, d) {
    const u = await verifyHello(d, g.nonce);
    if (!u || guests.get(conn.peer) !== g || g.uid) return;
    if (room.banned.some((b) => b.uid === u)) { removePeer(conn.peer, 'kicked'); broadcastState(); return; }
    g.uid = u;
    if (!room.allowed.includes(u)) room.allowed = [...room.allowed, u].slice(-200);
    broadcastState();
  }

  /** Why this person can't chat right now, or null if they can. */
  function chatBlocked(id) {
    const u = room.users.find((x) => x.id === id);
    if (u && u.muted) return "You're muted in this room.";
    if (room.settings.chat === 'mods' && roleOfPeer(id) === 'member') return 'Only moderators can chat right now.';
    return null;
  }

  function dropGuest(id) {
    const g = guests.get(id);
    if (!g) return;
    guests.delete(id);
    try { g.conn.close(); } catch { /* already closed */ }
    if (g.ready) {
      systemMsg(`${g.name} left`);
      if (room.share && room.share.peer === id) room.share = null;
      rebuildUsers();
      buffering.delete(id);
      if (room.waiting) evaluateWait();
      if (!checkVotes()) broadcastState();
    }
  }

  // Drop guests that stopped pinging (closed laptop, lost network).
  setInterval(() => {
    if (!isHost) return;
    const now = Date.now();
    for (const [id, g] of guests) if (now - g.lastSeen > 15000) dropGuest(id);
    const s = room.share;
    const sharerHere = s && (s.peer === myId || (guests.get(s.peer) && guests.get(s.peer).ready));
    if (s && !sharerHere) {
      if (!shareMissingSince) shareMissingSince = now;
      else if (now - shareMissingSince > 15000) {
        shareMissingSince = 0;
        room.share = null;
        systemMsg(`${s.name}'s tab share ended`);
        broadcastState();
      }
    } else shareMissingSince = 0;
  }, 4000);
  let shareMissingSince = 0;

  // =====================================================================
  //  GUEST — follows the host
  // =====================================================================
  function connectToHost(onFail) {
    let settled = false;
    let timer = null;
    let conn = null;
    const fail = (why) => {
      if (settled) return;
      settled = true;
      pendingConnectFail = null;
      clearTimeout(timer);
      try { if (conn) conn.close(); } catch { /* ignore */ }
      onFail(why);
    };
    conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
    pendingConnectFail = fail;
    timer = setTimeout(() => fail('timeout'), 9000);

    conn.on('open', () => {
      if (settled) return;
      settled = true;
      pendingConnectFail = null;
      clearTimeout(timer);
      hostConn = conn;
      lastPong = Date.now();
      pongSamples = [];
      migrating = false;
      helloSent = false;
      clearTimeout(helloTimer);
      // Rooms on an older version never send a challenge; say hello anyway after a moment.
      helloTimer = setTimeout(() => sendHello(null), 4000);
      setConnected(true);
    });
    conn.on('data', onHostData);
    conn.on('close', () => { if (hostConn === conn) onHostLost(); });
    conn.on('error', () => { if (hostConn === conn) onHostLost(); else fail('error'); });
  }

  let helloSent = false;
  let helloTimer = null;
  let joinPassword = '';
  let welcomed = false;
  let deniedReason = null;
  let lastJoinOpts = {};

  async function sendHello(nonce) {
    if (helloSent || !hostConn) return;
    helloSent = true;
    clearTimeout(helloTimer);
    const conn = hostConn;
    await ident.ready;
    let sig = null;
    try { if (nonce) sig = await signNonce(nonce); } catch { /* sign without a key */ }
    if (!conn.open) return;
    conn.send({ t: 'hello', name: myName, pub: ident.pub, sig, pass: joinPassword || undefined });
    for (let i = 0; i < 4; i++) setTimeout(sendPing, 150 * i);
  }

  async function sendProof(nonce) {
    const conn = hostConn;
    await ident.ready;
    let sig = null;
    try { sig = await signNonce(nonce); } catch { return; }
    if (sig && conn && conn.open) conn.send({ t: 'prove', pub: ident.pub, sig });
  }

  function handleDenied(reason) {
    if (deniedReason) return;
    deniedReason = reason;
    const c = hostConn;
    hostConn = null;
    try { if (c) c.close(); } catch { /* ignore */ }
    const wasInside = welcomed;
    if (wasInside) {
      return leaveWithNotice(reason === 'kicked' ? 'A moderator removed you from this room.' : 'This room now needs a password.');
    }
    try { if (peer) peer.destroy(); } catch { /* ignore */ }
    peer = null;
    if (reason === 'kicked') return lobbyError("You can't join this room: a moderator removed you from it.");
    const roomCode = code;
    (async () => {
      const pw = await ask({
        title: 'Password needed',
        label: reason === 'wrong-password' ? "That password didn't work. Try again:" : `Room ${roomCode} is private. Enter its password:`,
        ok: 'Join', type: 'password', maxLength: 64,
      });
      if (!pw) return lobbyError('This room needs a password to join.');
      setLobbyBusy(true);
      startGuest(roomCode, { ...lastJoinOpts, password: pw });
    })();
  }

  function leaveWithNotice(text) {
    try { sessionStorage.setItem('watchroom-notice', text); } catch { /* ignore */ }
    saveSnapshot();
    leaving = true;
    stopLocalShare();
    try { if (peer) peer.destroy(); } catch { /* ignore */ }
    location.href = location.pathname;
  }

  function sendPing() {
    if (hostConn && hostConn.open) { try { hostConn.send({ t: 'ping', c: Date.now() }); } catch { /* ignore */ } }
  }

  function onHostData(d) {
    if (!d || typeof d !== 'object') return;
    switch (d.t) {
      case 'challenge':
        if (typeof d.nonce !== 'string') break;
        if (!helloSent) sendHello(d.nonce.slice(0, 200));
        else sendProof(d.nonce.slice(0, 200));    // the challenge came late: prove who we are now
        break;
      case 'welcome':
        welcomed = true;
        chat = Array.isArray(d.chat) ? d.chat.slice(-MAX_CHAT) : [];
        renderAllChat();
        break;
      case 'denied':
        handleDenied(['kicked', 'password', 'wrong-password'].includes(d.reason) ? d.reason : 'kicked');
        break;
      case 'notice':
        if (typeof d.text === 'string') toast(d.text.slice(0, 200), 4000);
        break;
      case 'state':
        if (d.room && typeof d.room === 'object') {
          room = sanitizeRoom(d.room);
          render();
          syncPlayer();
        }
        break;
      case 'chat':
        if (d.m && typeof d.m === 'object') {
          chat.push(d.m);
          if (chat.length > MAX_CHAT) chat = chat.slice(-MAX_CHAT);
          appendChat(d.m);
        }
        break;
      case 'pong': {
        const now = Date.now();
        const rtt = now - d.c;
        if (!(rtt >= 0 && rtt < 10000)) return;
        lastPong = now;
        pongSamples.push({ rtt, offset: d.h + rtt / 2 - now });
        if (pongSamples.length > 10) pongSamples.shift();
        const best = pongSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        const first = pongSamples.length === 1;
        clockOffset = best.offset;
        if (first) applyState(false);
        break;
      }
      default:
        break;
    }
  }

  // Never trust what arrives over the wire more than we have to.
  function sanitizeMedia(m) {
    if (!m || typeof m !== 'object') return null;
    const out = {
      uid: String(m.uid || '').slice(0, 40),
      kind: SOURCE[m.kind] ? m.kind : 'video',
      src: String(m.src || ''),
      ytId: typeof m.ytId === 'string' && /^[\w-]{11}$/.test(m.ytId) ? m.ytId : null,
      title: typeof m.title === 'string' ? m.title.slice(0, 200) : '',
      titleSet: !!m.titleSet,
      by: cleanName(m.by),
      start: Math.max(0, Number(m.start) || 0),
    };
    if (!/^https?:\/\//i.test(out.src)) return null;
    if (out.kind === 'youtube' && !out.ytId) return null;
    if (out.kind === 'vimeo') {
      out.vid = /^\d{5,12}$/.test(m.vid) ? m.vid : null;
      out.hash = /^[a-f0-9]{6,20}$/i.test(m.hash || '') ? m.hash : '';
      if (!out.vid) return null;
    }
    if (out.kind === 'twitch') {
      out.twVideo = /^\d{5,12}$/.test(m.twVideo || '') ? m.twVideo : null;
      out.twChannel = /^[a-z0-9_]{3,25}$/.test(m.twChannel || '') ? m.twChannel : null;
      if (!out.twVideo && !out.twChannel) return null;
      out.live = !!out.twChannel;
    }
    if (out.kind === 'dailymotion') {
      out.dmId = /^[a-z0-9]{5,12}$/i.test(m.dmId || '') ? m.dmId : null;
      if (!out.dmId) return null;
    }
    return out;
  }
  function sanitizeRoom(r) {
    return {
      owner: typeof r.owner === 'string' ? r.owner.slice(0, 32) : null,
      mods: idList(r.mods, 50),
      settings: sanitizeSettings(r.settings),
      pass: r.pass && typeof r.pass.salt === 'string' && typeof r.pass.hash === 'string'
        ? { salt: r.pass.salt.slice(0, 64), hash: r.pass.hash.slice(0, 128) } : null,
      banned: Array.isArray(r.banned)
        ? r.banned.filter((b) => b && typeof b.uid === 'string').slice(0, 100).map((b) => ({ uid: b.uid.slice(0, 32), name: cleanName(b.name) })) : [],
      muted: idList(r.muted, 100),
      allowed: idList(r.allowed, 200),
      votes: r.votes && typeof r.votes.mid === 'string' ? { mid: r.votes.mid.slice(0, 40), voters: idList(r.votes.voters, 100) } : null,
      waiting: Array.isArray(r.waiting) ? r.waiting.slice(0, 20).map(cleanName) : null,
      name: cleanRoomName(r.name),
      media: sanitizeMedia(r.media),
      playing: !!r.playing,
      pos: Math.max(0, Number(r.pos) || 0),
      at: Number(r.at) || 0,
      rate: Number(r.rate) || 1,
      queue: Array.isArray(r.queue) ? r.queue.slice(0, MAX_QUEUE).map(sanitizeMedia).filter(Boolean) : [],
      users: Array.isArray(r.users)
        ? r.users.slice(0, 100).map((u) => ({
          id: String(u && u.id || ''), name: cleanName(u && u.name), host: !!(u && u.host),
          uid: u && typeof u.uid === 'string' ? u.uid.slice(0, 32) : null,
          role: u && (u.role === 'owner' || u.role === 'mod') ? u.role : 'member',
          muted: !!(u && u.muted),
        }))
        : [],
      share: r.share && typeof r.share === 'object' && typeof r.share.peer === 'string'
        ? { peer: r.share.peer.slice(0, 80), name: cleanName(r.share.name), sid: String(r.share.sid || '').slice(0, 40) }
        : null,
    };
  }

  // Heartbeat to the host; treat silence as the host leaving.
  setInterval(() => {
    if (isHost || !hostConn) return;
    sendPing();
    if (Date.now() - lastPong > 11000) onHostLost();
  }, 3000);

  function onHostLost() {
    if (leaving || isHost || migrating || deniedReason) return;
    migrating = true;
    if (hostConn) { try { hostConn.close(); } catch { /* ignore */ } hostConn = null; }
    setConnected(false, 'Host left · reconnecting');

    const lastRoom = room;
    // Owner first, then moderators, then whoever has been here longest.
    const weight = (u) => (u.role === 'owner' ? 0 : u.role === 'mod' ? 1 : 2);
    const others = lastRoom.users.filter((u) => !u.host)
      .map((u, i) => ({ u, i })).sort((a, b) => weight(a.u) - weight(b.u) || a.i - b.i).map((x) => x.u);
    const rank = Math.max(0, others.findIndex((u) => u.id === myId));
    let attempts = 0;

    const retry = () => setTimeout(tryOnce, 1500 + Math.random() * 1000);
    const tryOnce = () => {
      if (leaving || isHost || hostConn) return;
      attempts++;
      if (attempts > 14) {
        migrating = false;
        setConnected(false, 'Room closed', true);
        toast('Lost the room. Create a new one to keep watching.', 5000);
        return;
      }
      // The longest-connected guest re-opens the room; everyone else reconnects.
      if (rank === 0 || attempts > 3 + rank) {
        claimHost(lastRoom, (ok) => { if (!ok) connectToHost(retry); });
      } else {
        connectToHost(retry);
      }
    };
    setTimeout(tryOnce, 1500 + rank * 2000);
  }

  function claimHost(lastRoom, done) {
    const p = new Peer(PEER_PREFIX + code, PEER_OPTIONS);
    let settled = false;
    p.on('open', () => {
      if (settled) return;
      settled = true;
      const old = peer;
      peer = p;
      try { old.destroy(); } catch { /* ignore */ }
      becomeHost(lastRoom);
      done(true);
    });
    p.on('error', (err) => {
      if (settled) return;
      settled = true;
      try { p.destroy(); } catch { /* ignore */ }
      done(false);
    });
  }

  function becomeHost(lastRoom) {
    const pos = expectedPos(lastRoom);
    const oldId = myId;
    const oldHost = lastRoom.users.find((u) => u.host);
    isHost = true;
    migrating = false;
    myId = peer.id;
    clockOffset = 0;
    guests.clear();
    let share = lastRoom.share;
    if (share && oldHost && share.peer === oldHost.id) share = null;
    else if (share && share.peer === oldId) share = { ...share, peer: myId };
    room = { ...lastRoom, pos, at: Date.now(), users: [], share, waiting: null };
    if (!room.owner) room.owner = ident.uid;
    for (const c of outCalls.values()) { try { c.close(); } catch { /* ignore */ } }
    outCalls.clear();
    closeView();
    buffering.clear();
    if (!lastRoom.playing && lastRoom.waiting) room.playing = true;   // a wait in progress resumes
    wireHostPeer(peer);
    setConnected(true);
    systemMsg(`${myName} is now hosting`);
    broadcastState();
  }

  // =====================================================================
  //  PEER SETUP
  // =====================================================================
  function wireHostPeer(p) {
    p.on('connection', onGuestConnection);
    p.on('call', onIncomingCall);
    p.on('disconnected', () => { if (!p.destroyed && !leaving) try { p.reconnect(); } catch { /* ignore */ } });
    p.on('error', onPeerError);
  }

  function onPeerError(err) {
    const type = err && err.type;
    if (type === 'peer-unavailable' && pendingConnectFail) return pendingConnectFail('not-found');
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      if (!connected) return;
      toast("Lost the connection to the matchmaking server. Your room keeps running, but new people can't join until it's back.", 5000);
    }
  }

  /**
   * Opens a room with this browser as host.
   * opts.name      room name
   * opts.snapshot  { media, pos, queue } to restore when reopening a saved room
   * opts.created   true for a brand-new room (marks it as yours in My Rooms)
   * opts.fallbackGuest  join instead if someone already has the room open
   */
  function startHost(withCode, opts = {}) {
    code = withCode || genCode();
    stopLobbyPeer();
    const p = new Peer(PEER_PREFIX + code, PEER_OPTIONS);
    peer = p;
    let opened = false;
    p.on('open', async (id) => {
      opened = true;
      await ident.ready;
      isHost = true;
      myId = id;
      createdThisRoom = !!opts.created;
      room = emptyRoom();
      const saved = getSavedRoom(code);
      room.name = cleanRoomName(opts.name || (saved && saved.name)) || `${myName}'s room`;
      const snap = opts.snapshot;
      if (snap && typeof snap === 'object') {
        const m = sanitizeMedia(snap.media);
        if (m) { room.media = m; room.pos = Math.max(0, Number(snap.pos) || 0); room.at = hostNow(); room.playing = false; }
        room.queue = Array.isArray(snap.queue) ? snap.queue.slice(0, MAX_QUEUE).map(sanitizeMedia).filter(Boolean) : [];
        const extra = sanitizeRoom({ ...snap, users: [] });
        for (const k of ['owner', 'mods', 'settings', 'pass', 'banned', 'muted', 'allowed']) room[k] = extra[k];
      }
      if (!room.owner) room.owner = ident.uid;   // new rooms, and rooms saved before roles existed
      enterRoom();
      setConnected(true);
      systemMsg(withCode ? `${myName} reopened the room` : `${myName} opened the room`);
      broadcastState();
      if (!withCode) openInvite();
    });
    p.on('error', (err) => {
      if (!opened) {
        try { p.destroy(); } catch { /* ignore */ }
        if (err.type === 'unavailable-id') {
          if (withCode && opts.fallbackGuest) return startGuest(withCode);
          if (withCode) return lobbyError(`Room ${withCode} is already open. Join it instead.`);
          return startHost(null, opts);
        }
        return lobbyError(peerErrorText(err));
      }
      onPeerError(err);
    });
    p.on('connection', onGuestConnection);
    p.on('call', onIncomingCall);
    p.on('disconnected', () => { if (!p.destroyed && !leaving) try { p.reconnect(); } catch { /* ignore */ } });
  }

  /** Joins a room. opts.fallbackHost: a saved room to reopen if nobody turns out to be inside. */
  function startGuest(roomCode, opts = {}) {
    code = roomCode;
    createdThisRoom = false;
    lastJoinOpts = opts;
    deniedReason = null;
    welcomed = false;
    const saved = getSavedRoom(roomCode);
    joinPassword = opts.password || (saved && saved.pass) || '';
    stopLobbyPeer();
    const p = new Peer(PEER_OPTIONS);
    peer = p;
    p.on('call', onIncomingCall);
    let opened = false;
    p.on('open', (id) => {
      opened = true;
      myId = id;
      connectToHost((why) => {
        try { p.destroy(); } catch { /* ignore */ }
        peer = null;
        if (why === 'not-found' && opts.fallbackHost) {
          const r = opts.fallbackHost;
          return startHost(roomCode, { name: r.name, snapshot: r.snapshot });
        }
        if (why === 'not-found') lobbyError(`Nobody is in room ${roomCode} right now.`, roomCode);
        else lobbyError("Couldn't connect to the room. Some networks block peer-to-peer connections; try another network or ask the host for a new link.");
      });
      // Show the room once the host lets us in.
      const startedAt = Date.now();
      const wait = setInterval(() => {
        if (welcomed) { clearInterval(wait); enterRoom(); return; }
        if (!peer || deniedReason) { clearInterval(wait); return; }
        if (Date.now() - startedAt > 20000) {
          clearInterval(wait);
          try { peer.destroy(); } catch { /* ignore */ }
          peer = null;
          hostConn = null;
          lobbyError("The room didn't let you in. Try again in a moment.");
        }
      }, 50);
    });
    p.on('error', (err) => {
      if (!opened) {
        try { p.destroy(); } catch { /* ignore */ }
        peer = null;
        return lobbyError(peerErrorText(err));
      }
      onPeerError(err);
    });
    p.on('disconnected', () => { if (!p.destroyed && !leaving) try { p.reconnect(); } catch { /* ignore */ } });
  }

  function peerErrorText(err) {
    const type = err && err.type;
    if (type === 'browser-incompatible') return "This browser can't do peer-to-peer connections. Try a recent Chrome, Edge, Firefox or Safari.";
    if (type === 'network' || type === 'server-error' || type === 'socket-error') return "Couldn't reach the matchmaking server. Check your connection and try again.";
    return 'Something went wrong while connecting. Try again.';
  }

  // =====================================================================
  //  UI
  // =====================================================================
  function setConnected(ok, text, bad) {
    connected = ok;
    const pill = $('sync-pill');
    pill.classList.remove('pill-ok', 'pill-wait', 'pill-bad');
    if (ok) {
      pill.classList.add('pill-ok');
      $('sync-text').textContent = isHost ? 'You are hosting' : 'In sync';
    } else {
      pill.classList.add(bad ? 'pill-bad' : 'pill-wait');
      $('sync-text').textContent = text || 'Connecting';
    }
  }

  function enterRoom() {
    stopLobbyPeer();
    $('lobby').hidden = true;
    $('room').hidden = false;
    $('room-code').textContent = code;
    if (location.hash.slice(1) !== code) history.replaceState(null, '', '#' + code);
    const saved = getSavedRoom(code);
    upsertRoom({
      code,
      name: room.name || (saved && saved.name) || '',
      owner: saved ? !!saved.owner || createdThisRoom : createdThisRoom,
      lastVisited: Date.now(),
      ...(joinPassword ? { pass: joinPassword } : {}),
    });
    render();
    renderAllChat();
  }

  function render() {
    const m = room.media;
    if (room.share) {
      $('now-title').textContent = room.share.peer === myId ? 'Your tab' : `${room.share.name}'s tab`;
      $('now-by').textContent = 'Live tab share';
    } else {
      $('now-title').textContent = m ? (m.title || fallbackTitle(m)) : 'Nothing playing';
      $('now-by').textContent = m ? `Added by ${m.by}` : '';
    }
    $('room-name').textContent = room.name || '';
    document.title = `${room.name || code} · Watchroom`;
    renderShare();
    reconcileShare();
    saveSnapshotSoon();
    $('stage-error-next').textContent = room.queue.length ? 'Skip to next' : 'Clear player';
    renderPermissions();
    renderSettings();
    const w = room.waiting && !room.share ? room.waiting : null;
    $('wait-banner').hidden = !w;
    if (w) $('wait-text').textContent = w.length === 1 && w[0] === myName ? 'Loading… the room is waiting for you' : `Waiting for ${w.join(', ')} to load…`;
    $('queue-count').textContent = room.queue.length;
    $('people-count').textContent = Math.max(1, room.users.length);
    renderQueue();
    renderPeople();
  }

  function renderQueue() {
    const list = $('queue-list');
    list.textContent = '';
    $('queue-empty').hidden = room.queue.length > 0;
    room.queue.forEach((q, i) => {
      const li = document.createElement('li');
      li.className = 'q-item';

      const pos = document.createElement('span');
      pos.className = 'q-pos';
      pos.textContent = String(i + 1);

      const main = document.createElement('div');
      main.className = 'q-main';
      const title = document.createElement('span');
      title.className = 'q-title';
      title.textContent = q.title || fallbackTitle(q);
      title.title = title.textContent;
      const sub = document.createElement('span');
      sub.className = 'q-sub';
      sub.textContent = `${SOURCE[q.kind] || 'Video'}${q.live ? ' live' : ''} · ${q.by}`;
      main.append(title, sub);

      const actions = document.createElement('div');
      actions.className = 'q-actions';
      actions.hidden = !canControl();
      actions.append(
        iconBtn('▶', 'Play now', () => sendAction({ type: 'playNow', uid: q.uid })),
        iconBtn('↑', 'Move up', () => sendAction({ type: 'up', uid: q.uid }), i === 0),
        iconBtn('✕', 'Remove', () => sendAction({ type: 'remove', uid: q.uid })),
      );
      li.append(pos, main, actions);
      list.appendChild(li);
    });
  }

  function iconBtn(glyph, label, onClick, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.textContent = glyph;
    b.title = label;
    b.setAttribute('aria-label', label);
    if (disabled) b.disabled = true;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderPeople() {
    const list = $('people-list');
    list.textContent = '';
    const users = room.users.length ? room.users : [{ id: myId, name: myName, host: isHost, role: 'member' }];
    const myRole = (me() || {}).role || 'member';
    for (const u of users) {
      const li = document.createElement('li');
      li.className = 'person';
      const av = document.createElement('span');
      av.className = 'avatar';
      av.style.background = colorFor(u.name + u.id);
      av.textContent = (u.name.match(/\p{L}|\p{N}/u) || ['?'])[0].toUpperCase();
      const nm = document.createElement('span');
      nm.className = 'person-name';
      nm.textContent = u.name;
      const tags = document.createElement('span');
      tags.className = 'person-tags';
      if (u.role === 'owner') tags.append(tag('Owner', 'owner'));
      if (u.role === 'mod') tags.append(tag('Mod', 'mod'));
      if (u.muted) tags.append(tag('Muted', 'muted'));
      if (u.id === myId) tags.append(tag('You'));
      li.append(av, nm, tags);
      const canTouch = u.id !== myId && u.role !== 'owner' && (myRole === 'owner' || (myRole === 'mod' && u.role === 'member'));
      if (canTouch) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'icon-btn person-more';
        more.textContent = '⋯';
        more.setAttribute('aria-label', `Options for ${u.name}`);
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          const items = [];
          if (myRole === 'owner' && u.uid) {
            items.push(u.role === 'mod'
              ? { label: 'Remove as moderator', run: () => sendAction({ type: 'unmod', target: u.id }) }
              : { label: 'Make moderator', run: () => sendAction({ type: 'mod', target: u.id }) });
          }
          items.push(u.muted
            ? { label: 'Unmute in chat', run: () => sendAction({ type: 'unmute', target: u.id }) }
            : { label: 'Mute in chat', run: () => sendAction({ type: 'mute', target: u.id }) });
          items.push({ label: 'Remove from room', danger: true, run: () => sendAction({ type: 'kick', target: u.id }) });
          openPopMenu(more, items);
        });
        li.append(more);
      }
      list.appendChild(li);
    }
  }
  function tag(text, kind) {
    const t = document.createElement('span');
    t.className = kind ? `tag tag-${kind}` : 'tag';
    t.textContent = text;
    return t;
  }

  // ---------- permissions in the UI ----------
  const canControl = () => iAmMod() || room.settings.playback === 'all';
  const canAdd = () => iAmMod() || room.settings.adding === 'all';

  function renderPermissions() {
    const mod = iAmMod();
    const S = room.settings;
    const control = canControl();
    const add = canAdd();
    $('url-input').disabled = !control && !add;
    $('url-input').placeholder = !control && !add ? 'Only moderators can add videos in this room'
      : (YT_KEY ? 'Paste a link or search YouTube' : 'Paste a YouTube, Vimeo, Twitch or video link');
    $('add-form').querySelector('[data-mode=play]').disabled = !control;
    $('add-form').querySelector('[data-mode=queue]').disabled = !add;
    $('share-btn').disabled = !control;
    $('share-btn').title = control ? 'Stream one of your browser tabs to the room' : 'Only moderators can share in this room';

    // Next / vote to skip
    const next = $('next-btn');
    const voting = !mod && S.skip === 'vote';
    if (voting) {
      const have = liveVoters().length;
      const voted = !!(room.votes && room.media && room.votes.mid === room.media.uid && room.votes.voters.includes(myId));
      next.textContent = voted ? `Voted · ${have}/${votesNeeded()}` : (have ? `Vote to skip · ${have}/${votesNeeded()}` : 'Vote to skip');
      next.disabled = voted || !room.media || !control;
    } else {
      next.textContent = 'Next in queue';
      next.disabled = room.queue.length === 0 || !control;
    }

    // Chat
    const self = me();
    const muted = !!(self && self.muted);
    const chatLocked = S.chat === 'mods' && !mod;
    const input = $('chat-input');
    input.disabled = muted || chatLocked;
    input.placeholder = muted ? "You're muted in this room" : chatLocked ? 'Only moderators can chat right now' : 'Say something';
    $('chat-form').querySelector('button').disabled = muted || chatLocked;

    // Plain-language summary of the rules, for everyone
    const rules = [];
    rules.push(S.playback === 'mods' ? 'Only moderators can play, pause and skip.' : 'Everyone can play, pause and skip.');
    if (S.adding === 'mods') rules.push('Only moderators can add videos.');
    if (S.chat === 'mods') rules.push('Only moderators can chat.');
    if (S.skip === 'vote') rules.push('Skipping needs a majority vote, except for moderators.');
    if (room.pass) rules.push('The room has a password.');
    $('room-rules').textContent = rules.join(' ');
    $('room-rules').hidden = mod;
  }

  function renderSettings() {
    const mod = iAmMod();
    $('room-settings').hidden = !mod;
    if (!mod) return;
    for (const seg of document.querySelectorAll('#room-settings .seg')) {
      const k = seg.dataset.setting;
      const v = k === 'waitBuffer' ? (room.settings.waitBuffer ? 'on' : 'off') : room.settings[k];
      for (const b of seg.querySelectorAll('button')) {
        const on = b.dataset.v === v;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', String(on));
      }
    }
    $('pw-state').textContent = room.pass ? 'On' : 'Off';
    $('pw-state').classList.toggle('is-on', !!room.pass);
    $('pw-set').textContent = room.pass ? 'Change' : 'Set password';
    $('pw-clear').hidden = !room.pass;
    const kicked = $('kicked-list');
    kicked.textContent = '';
    $('kicked-box').hidden = !room.banned.length;
    for (const b of room.banned) {
      const li = document.createElement('li');
      const n = document.createElement('span');
      n.textContent = b.name;
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'btn btn-ghost btn-sm';
      back.textContent = 'Let back in';
      back.addEventListener('click', () => sendAction({ type: 'unban', uid: b.uid }));
      li.append(n, back);
      kicked.appendChild(li);
    }
  }

  document.querySelectorAll('#room-settings .seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const key = seg.dataset.setting;
      const value = key === 'waitBuffer' ? b.dataset.v === 'on' : b.dataset.v;
      sendAction({ type: 'setting', key, value });
    });
  });
  $('pw-set').addEventListener('click', async () => {
    const pw = await ask({
      title: room.pass ? 'Change password' : 'Set a password',
      label: 'People joining will need this. Everyone already here stays in.',
      ok: 'Save', type: 'password', maxLength: 64,
    });
    if (!pw) return;
    updateRoom(code, { pass: pw });
    sendAction({ type: 'setPassword', password: pw });
  });
  $('pw-clear').addEventListener('click', () => sendAction({ type: 'clearPassword' }));

  // ---------- small floating menu (people options) ----------
  function openPopMenu(anchor, items) {
    const menu = $('pop-menu');
    menu.textContent = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = it.label;
      if (it.danger) b.className = 'danger';
      b.addEventListener('click', () => { closePopMenu(); it.run(); });
      menu.appendChild(b);
    }
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    menu.style.top = `${r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
    if (menu.firstChild) menu.firstChild.focus();
  }
  function closePopMenu() { $('pop-menu').hidden = true; }
  document.addEventListener('click', (e) => { if (!$('pop-menu').hidden && !$('pop-menu').contains(e.target)) closePopMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopMenu(); });
  window.addEventListener('resize', closePopMenu);

  function chatNode(m) {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = clock(Number(m.ts) || Date.now());
    if (m.system) {
      li.className = 'msg-system';
      const text = document.createElement('span');
      renderWithTimestamps(text, String(m.text || ''));
      li.append(time, text);
      return li;
    }
    li.className = 'msg';
    const head = document.createElement('div');
    head.className = 'msg-head';
    const name = document.createElement('span');
    name.className = 'msg-name';
    name.textContent = cleanName(m.name);
    head.append(name, time);
    const text = document.createElement('div');
    text.className = 'msg-text';
    renderWithTimestamps(text, String(m.text || '').slice(0, 400));
    li.append(head, text);
    return li;
  }
  // "12:34" or "1:02:03" in chat becomes a button that takes everyone there.
  const TS_RE = /\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b/g;
  function renderWithTimestamps(el, text) {
    let last = 0;
    for (const m of text.matchAll(TS_RE)) {
      el.append(text.slice(last, m.index));
      const secs = (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ts';
      b.textContent = m[0];
      b.title = `Jump everyone to ${m[0]}`;
      b.addEventListener('click', () => jumpTo(secs));
      el.append(b);
      last = m.index + m[0].length;
    }
    el.append(text.slice(last));
  }
  function jumpTo(secs) {
    if (room.share) return toast("You can't jump during a tab share.");
    if (!room.media) return toast('Nothing is playing.');
    if (room.media.live) return toast("You can't jump in a live stream.");
    if (!canControl()) return toast('Only moderators can control playback in this room.');
    sendAction({ type: 'seek', pos: secs });
  }

  function appendChat(m) {
    const list = $('chat-list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.appendChild(chatNode(m));
    while (list.children.length > MAX_CHAT) list.firstChild.remove();
    if (nearBottom) list.scrollTop = list.scrollHeight;
    if (!m.system && $('panel-chat').hidden) $('tab-chat').classList.add('has-new');
  }
  function renderAllChat() {
    const list = $('chat-list');
    list.textContent = '';
    for (const m of chat) list.appendChild(chatNode(m));
    list.scrollTop = list.scrollHeight;
  }

  function lobbyError(text, offerCode) {
    $('room').hidden = true;
    $('lobby').hidden = false;
    setLobbyBusy(false);
    const inRooms = !$('rooms-view').hidden;
    const el = inRooms ? $('rooms-error') : $('lobby-error');
    el.textContent = text + ' ';
    if (offerCode) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost btn-sm';
      b.textContent = `Open room ${offerCode} yourself`;
      b.addEventListener('click', () => {
        if (!inRooms && !readName()) return;
        setLobbyBusy(true);
        const saved = getSavedRoom(offerCode);
        startHost(offerCode, { name: saved && saved.name, snapshot: saved && saved.snapshot });
      });
      el.appendChild(b);
    }
    el.hidden = false;
    if (inRooms) refreshRooms();
  }

  function setLobbyBusy(busy) {
    $('create-btn').disabled = busy;
    $('join-btn').disabled = busy;
    $('new-room-btn').disabled = busy;
    $('rooms-view').classList.toggle('is-busy', busy);
    if (busy) { $('lobby-error').hidden = true; $('rooms-error').hidden = true; }
  }

  // ---------- actions out ----------
  function sendAction(a) {
    if (!('mid' in a)) a.mid = room.media ? room.media.uid : null;
    if (isHost) handleAction(myId, a);
    else if (hostConn && hostConn.open) hostConn.send({ t: 'action', a });
    else toast('Reconnecting to the room…');
  }

  // =====================================================================
  //  MY ROOMS — saved in this browser, with a live "who's inside" check
  // =====================================================================
  const ROOMS_KEY = 'watchroom-rooms';
  let createdThisRoom = false;

  function loadRooms() {
    try {
      const list = JSON.parse(store.get(ROOMS_KEY) || '[]');
      return Array.isArray(list) ? list.filter((r) => r && typeof r.code === 'string' && /^[A-Z0-9]{6}$/.test(r.code)) : [];
    } catch { return []; }
  }
  function saveRooms(list) { store.set(ROOMS_KEY, JSON.stringify(list.slice(0, 40))); }
  function getSavedRoom(c) { return loadRooms().find((r) => r.code === c) || null; }
  /** Adds or updates a room and moves it to the top. */
  function upsertRoom(patch) {
    const list = loadRooms();
    const i = list.findIndex((r) => r.code === patch.code);
    const merged = { ...(i >= 0 ? list[i] : { createdAt: Date.now() }), ...patch };
    if (i >= 0) list.splice(i, 1);
    list.unshift(merged);
    saveRooms(list);
  }
  /** Updates a room in place, without changing the order. */
  function updateRoom(c, patch) {
    const list = loadRooms();
    const i = list.findIndex((r) => r.code === c);
    if (i < 0) return;
    list[i] = { ...list[i], ...patch };
    saveRooms(list);
  }
  function removeRoom(c) { saveRooms(loadRooms().filter((r) => r.code !== c)); }

  let snapTimer = null;
  function saveSnapshotSoon() {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(saveSnapshot, 1500);
  }
  function saveSnapshot() {
    clearTimeout(snapTimer);
    if (!code || !$('lobby').hidden) return;
    const patch = {
      snapshot: {
        media: room.media, pos: expectedPos(), queue: room.queue,
        owner: room.owner, mods: room.mods, settings: room.settings, pass: room.pass,
        banned: room.banned, muted: room.muted, allowed: room.allowed,
      },
    };
    if (room.name) patch.name = room.name;
    updateRoom(code, patch);
  }

  // ---------- live check ----------
  let lobbyPeer = null;
  let lobbyTimer = null;
  const roomStatus = new Map();         // code -> { state: checking|live|empty|unknown, users, now, share }
  const probeFinishers = new Map();     // host peer id -> finish()

  function openLobbyPeer() {
    if (lobbyPeer && !lobbyPeer.destroyed && lobbyPeer.open) return Promise.resolve(lobbyPeer);
    if (lobbyPeer && lobbyPeer._opening) return lobbyPeer._opening;
    const p = new Peer(PEER_OPTIONS);
    lobbyPeer = p;
    p._opening = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 10000);
      p.on('open', () => { clearTimeout(t); resolve(p); });
      p.on('error', (err) => {
        if (err && err.type === 'peer-unavailable') {
          const m = String(err.message || '').match(/peer\s+(\S+)/i);
          const finish = m && probeFinishers.get(m[1]);
          if (finish) finish({ state: 'empty' });
          return;
        }
        if (!p.open) { clearTimeout(t); resolve(null); }
      });
    });
    p.on('disconnected', () => { if (!p.destroyed) try { p.reconnect(); } catch { /* ignore */ } });
    return p._opening;
  }

  function stopLobbyPeer() {
    clearInterval(lobbyTimer);
    lobbyTimer = null;
    for (const finish of [...probeFinishers.values()]) finish(null);
    probeFinishers.clear();
    if (lobbyPeer) { try { lobbyPeer.destroy(); } catch { /* ignore */ } lobbyPeer = null; }
    $('rooms-refresh').classList.remove('is-spinning');
  }

  function setRoomStatus(c, st) {
    roomStatus.set(c, st);
    if (st.state === 'live' && st.name) {
      const saved = getSavedRoom(c);
      if (saved && saved.name !== st.name) updateRoom(c, { name: st.name });
    }
    renderRooms();
  }

  async function refreshRooms() {
    const rooms = loadRooms();
    if (!rooms.length || $('rooms-view').hidden || $('lobby').hidden) { renderRooms(); return; }
    $('rooms-refresh').classList.add('is-spinning');
    const p = await openLobbyPeer();
    if (!p || $('rooms-view').hidden || $('lobby').hidden) {
      $('rooms-refresh').classList.remove('is-spinning');
      if (!p && !$('rooms-view').hidden) {
        for (const r of rooms) roomStatus.set(r.code, { state: 'unknown' });
        renderRooms();
        $('rooms-error').textContent = "Couldn't check who's in your rooms: the matchmaking server didn't answer. You can still open them.";
        $('rooms-error').hidden = false;
      }
      return;
    }
    for (const r of rooms) probeRoom(p, r.code);
  }

  function probeRoom(p, c) {
    const id = PEER_PREFIX + c;
    if (probeFinishers.has(id)) return;
    const prev = roomStatus.get(c);
    if (!prev || prev.state === 'unknown') { roomStatus.set(c, { state: 'checking' }); renderRooms(); }
    let done = false;
    let conn = null;
    let timer = null;
    let grace = null;
    const finish = (st) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      probeFinishers.delete(id);
      try { if (conn) conn.close(); } catch { /* ignore */ }
      if (st) setRoomStatus(c, st);
      if (!probeFinishers.size) $('rooms-refresh').classList.remove('is-spinning');
    };
    probeFinishers.set(id, finish);
    try { conn = p.connect(id, { reliable: true, serialization: 'json' }); } catch { conn = null; }
    if (!conn) return finish({ state: 'unknown' });
    timer = setTimeout(() => finish({ state: 'empty' }), 8000);
    conn.on('open', () => {
      try { conn.send({ t: 'peek' }); } catch { /* ignore */ }
      // Rooms running an older version don't answer peeks but are clearly open.
      grace = setTimeout(() => finish({ state: 'live', users: null }), 3000);
    });
    conn.on('data', (d) => {
      if (!d || d.t !== 'peekInfo') return;
      if (d.private) {
        return finish({ state: 'live', private: true, count: Math.max(0, Math.min(999, Number(d.count) || 0)), name: cleanRoomName(d.name) });
      }
      finish({
        state: 'live',
        users: Array.isArray(d.users) ? d.users.slice(0, 100).map((u) => cleanName(u && u.name)) : null,
        name: cleanRoomName(d.name),
        now: typeof d.now === 'string' ? d.now.slice(0, 120) : '',
        share: !!d.share,
      });
    });
    conn.on('error', () => finish({ state: 'empty' }));
  }

  // ---------- rendering ----------
  function avatarEl(name, extraClass) {
    const a = document.createElement('span');
    a.className = 'avatar' + (extraClass ? ' ' + extraClass : '');
    a.style.background = colorFor(name);
    a.textContent = (String(name).match(/\p{L}|\p{N}/u) || ['?'])[0].toUpperCase();
    a.title = name;
    return a;
  }

  function occupancyEl(st) {
    const box = document.createElement('div');
    box.className = 'occupancy';
    if (!st || st.state === 'checking') {
      const dots = document.createElement('span');
      dots.className = 'checking';
      dots.innerHTML = '<span></span><span></span><span></span>';
      const l = document.createElement('span');
      l.className = 'occ-label';
      l.textContent = 'Checking';
      box.append(dots, l);
    } else if (st.state === 'live' && st.private) {
      const l = document.createElement('span');
      l.className = 'lock occ-live';
      l.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
      l.append(document.createTextNode(st.count ? `Private · ${st.count} inside` : 'Private'));
      box.append(l);
    } else if (st.state === 'live') {
      const users = st.users;
      if (users && users.length) {
        const stack = document.createElement('div');
        stack.className = 'stack';
        users.slice(0, 5).forEach((n) => stack.appendChild(avatarEl(n)));
        if (users.length > 5) {
          const more = document.createElement('span');
          more.className = 'avatar more';
          more.textContent = `+${users.length - 5}`;
          stack.appendChild(more);
        }
        const l = document.createElement('span');
        l.className = 'occ-label occ-live';
        l.textContent = `${users.length} inside`;
        box.append(stack, l);
      } else {
        const l = document.createElement('span');
        l.className = 'occ-live';
        l.textContent = 'Open now';
        box.append(l);
      }
    } else if (st.state === 'empty') {
      box.textContent = 'Nobody here';
    } else {
      box.textContent = '—';
    }
    return box;
  }

  function renderRooms() {
    const list = $('rooms-list');
    const rooms = loadRooms();
    list.textContent = '';
    $('rooms-empty').hidden = rooms.length > 0;
    for (const r of rooms) {
      const st = roomStatus.get(r.code);
      const li = document.createElement('li');
      li.className = 'room-row';

      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'icon-btn row-menu-btn';
      menuBtn.textContent = '☰';
      menuBtn.setAttribute('aria-label', `Options for ${r.name || r.code}`);
      menuBtn.setAttribute('aria-haspopup', 'menu');
      menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openRowMenu(menuBtn, r.code); });

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'room-open';
      open.addEventListener('click', () => enterSavedRoom(r.code));

      const info = document.createElement('div');
      info.className = 'room-info';
      const name = document.createElement('span');
      name.className = 'room-name';
      name.textContent = r.name || `Room ${r.code}`;
      const sub = document.createElement('span');
      sub.className = 'room-sub';
      const codeEl = document.createElement('span');
      codeEl.className = 'code';
      codeEl.textContent = r.code;
      const owner = document.createElement('span');
      owner.textContent = r.owner ? 'Created by you' : 'Joined';
      sub.append(codeEl, owner);
      if (st && st.state === 'live' && (st.share || st.now)) {
        const now = document.createElement('span');
        now.className = 'room-now';
        now.textContent = st.share ? 'Live tab share' : `Watching ${st.now}`;
        sub.append(now);
      }
      info.append(name, sub);

      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.setAttribute('aria-hidden', 'true');
      chev.textContent = '›';

      open.append(info, occupancyEl(st), chev);
      li.append(menuBtn, open);
      list.appendChild(li);
    }
  }

  function showRoomsView() {
    $('welcome').hidden = true;
    $('rooms-view').hidden = false;
    $('lobby').classList.add('is-rooms');
    renderMe();
    renderRooms();
    refreshRooms();
    clearInterval(lobbyTimer);
    lobbyTimer = setInterval(() => {
      if (!document.hidden && !$('rooms-view').hidden && !$('lobby').hidden) refreshRooms();
    }, 20000);
  }

  function renderMe() {
    $('me-name').textContent = myName;
    const av = $('me-avatar');
    av.style.background = colorFor(myName);
    av.textContent = (myName.match(/\p{L}|\p{N}/u) || ['?'])[0].toUpperCase();
  }

  function enterSavedRoom(c) {
    const r = getSavedRoom(c);
    if (!r) return;
    const st = roomStatus.get(c);
    setLobbyBusy(true);
    if (st && st.state === 'live') startGuest(c, { fallbackHost: r });
    else startHost(c, { name: r.name, snapshot: r.snapshot, fallbackGuest: true });
  }

  // ---------- row menu ----------
  let menuCode = null;
  function openRowMenu(btn, c) {
    const menu = $('row-menu');
    if (!menu.hidden && menuCode === c) return closeRowMenu();
    menuCode = c;
    const host = $('rooms-view').querySelector('.rooms-main').getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    menu.style.left = `${b.left - host.left}px`;
    menu.style.top = `${b.bottom - host.top + 6}px`;
    menu.hidden = false;
    menu.querySelector('button').focus();
  }
  function closeRowMenu() { $('row-menu').hidden = true; menuCode = null; }
  document.addEventListener('click', (e) => { if (!$('row-menu').hidden && !$('row-menu').contains(e.target)) closeRowMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('row-menu').hidden) closeRowMenu(); });

  $('row-menu').addEventListener('click', async (e) => {
    const act = e.target.closest('button') && e.target.closest('button').dataset.act;
    const c = menuCode;
    if (!act || !c) return;
    closeRowMenu();
    const r = getSavedRoom(c);
    if (!r) return;
    if (act === 'rename') {
      const name = await ask({ title: 'Rename room', label: 'Room name', value: r.name || '', placeholder: `Room ${c}`, ok: 'Save' });
      if (name === null) return;
      updateRoom(c, { name: cleanRoomName(name) });
      renderRooms();
    } else if (act === 'copy') {
      const ok = await copyText(`${location.origin}${location.pathname}#${c}`);
      toast(ok ? 'Invite link copied' : `${location.origin}${location.pathname}#${c}`, ok ? 2600 : 8000);
    } else if (act === 'remove') {
      removeRoom(c);
      roomStatus.delete(c);
      renderRooms();
      toast(`Removed ${r.name || c} from your rooms`);
    }
  });

  // ---------- naming dialog (create room, rename, change your name) ----------
  let askResolve = null;
  function ask({ title, label, value = '', placeholder = '', ok, maxLength = 40, type = 'text' }) {
    return new Promise((resolve) => {
      const d = $('ask-dialog');
      if (typeof d.showModal !== 'function') {
        const v = window.prompt(label, value || placeholder);
        resolve(v === null ? null : (v.trim() || placeholder));
        return;
      }
      $('ask-title').textContent = title;
      $('ask-label').textContent = label;
      const input = $('ask-input');
      input.value = value;
      input.placeholder = placeholder;
      input.maxLength = maxLength;
      input.type = type;
      input.autocomplete = type === 'password' ? 'current-password' : 'off';
      $('ask-ok').textContent = ok;
      askResolve = resolve;
      d.showModal();
      input.focus();
      input.select();
    });
  }
  function closeAsk(val) {
    const r = askResolve;
    askResolve = null;
    if ($('ask-dialog').open) $('ask-dialog').close();
    if (r) r(val);
  }
  $('ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('ask-input');
    closeAsk(input.value.trim() || input.placeholder || '');
  });
  $('ask-close').addEventListener('click', () => closeAsk(null));
  $('ask-cancel').addEventListener('click', () => closeAsk(null));
  $('ask-dialog').addEventListener('cancel', (e) => { e.preventDefault(); closeAsk(null); });
  $('ask-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeAsk(null); });

  async function createRoomFlow() {
    const name = await ask({ title: 'New room', label: 'Room name', placeholder: `${myName}'s room`, ok: 'Create room' });
    if (name === null) return;
    setLobbyBusy(true);
    startHost(null, { name: cleanRoomName(name), created: true });
  }

  $('new-room-btn').addEventListener('click', createRoomFlow);
  $('rooms-empty-create').addEventListener('click', createRoomFlow);
  $('rooms-refresh').addEventListener('click', () => { $('rooms-error').hidden = true; refreshRooms(); });
  $('rooms-join').addEventListener('submit', (e) => {
    e.preventDefault();
    const c = normCode($('rooms-code').value);
    if (c.length !== 6) {
      $('rooms-error').textContent = 'Room codes are 6 characters, like K7QX2M.';
      $('rooms-error').hidden = false;
      $('rooms-code').focus();
      return;
    }
    setLobbyBusy(true);
    const saved = getSavedRoom(c);
    startGuest(c, saved ? { fallbackHost: saved } : {});
  });
  $('rooms-code').addEventListener('input', (e) => { e.target.value = normCode(e.target.value); });
  $('me-chip').addEventListener('click', async () => {
    const n = await ask({ title: 'Your name', label: 'The name others see', value: myName, placeholder: myName, ok: 'Save', maxLength: 24 });
    if (n === null) return;
    myName = cleanName(n);
    store.set('watchroom-name', myName);
    $('name-input').value = myName;
    renderMe();
  });

  // =====================================================================
  //  EVENTS
  // =====================================================================
  function readName() {
    const n = $('name-input').value.trim();
    if (!n) {
      $('name-input').focus();
      $('lobby-error').textContent = 'Enter a name so the others know who you are.';
      $('lobby-error').hidden = false;
      return false;
    }
    myName = cleanName(n);
    store.set('watchroom-name', myName);
    return true;
  }

  let hashCode = normCode(location.hash.slice(1));

  $('lobby-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!readName()) return;
    if (hashCode.length === 6) {
      setLobbyBusy(true);
      const saved = getSavedRoom(hashCode);
      startGuest(hashCode, saved ? { fallbackHost: saved } : {});
    } else {
      createRoomFlow();
    }
  });

  $('join-btn').addEventListener('click', () => {
    const c = normCode($('code-input').value);
    if (c.length !== 6) {
      $('lobby-error').textContent = 'Room codes are 6 characters, like K7QX2M.';
      $('lobby-error').hidden = false;
      $('code-input').focus();
      return;
    }
    if (!readName()) return;
    setLobbyBusy(true);
    startGuest(c);
  });
  $('code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('join-btn').click(); }
  });
  $('code-input').addEventListener('input', (e) => { e.target.value = normCode(e.target.value); });

  $('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const mode = (e.submitter && e.submitter.dataset.mode) || 'play';
    const raw = $('url-input').value.trim();
    if (!raw) return $('url-input').focus();
    const looksLikeLink = /^\S+\.\S+$/.test(raw) || /^https?:/i.test(raw);
    const m = parseMedia(raw);
    if (!m && !looksLikeLink) {
      if (!YT_KEY) return toast("Search isn't set up on this site yet. Paste a video link instead.", 5000);
      runSearch(raw);
      return;
    }
    if (!m) {
      toast("That link isn't a YouTube, Vimeo, Twitch or Dailymotion video, or a direct video file.", 4000);
      return;
    }
    if (m.kind === 'unsupported') return toast(m.reason, 6000);
    if (m.kind === 'dailymotion' && !DM_PLAYER_ID) return toast('Dailymotion links need a free Player ID set in js/config.js. The README explains how.', 6000);
    if (m.kind === 'ytplaylist') {
      $('url-input').value = '';
      addPlaylist(m.list, mode);
      return;
    }
    if (m.inList) setTimeout(() => toast('Added this one video. To add the whole playlist, paste its playlist link (youtube.com/playlist?list=…).', 6000), 2700);
    const queued = mode === 'queue' && !!room.media;
    sendAction({ type: mode === 'queue' ? 'enqueue' : 'load', media: { raw } });
    $('url-input').value = '';
    if (queued) toast('Added to the queue');
  });

  // ---------- YouTube search ----------
  const decodeHtml = (s) => { const t = document.createElement('textarea'); t.innerHTML = s || ''; return t.value; };
  function isoDuration(iso) {
    const m = String(iso || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    if (!m) return '';
    return fmt((+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)));
  }
  function apiErrorText(j) {
    const reason = j && j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return "Today's search limit is used up. Paste a link, or try again tomorrow.";
    if (reason === 'keyInvalid' || reason === 'badRequest') return "The YouTube API key in js/config.js isn't valid.";
    if (reason === 'forbidden' || reason === 'ipRefererBlocked' || reason === 'accessNotConfigured') return "This site isn't allowed to use the YouTube API key. Check the key's restrictions and that YouTube Data API v3 is enabled.";
    return (j && j.error && j.error.message) || 'YouTube search failed.';
  }

  let searchSeq = 0;
  async function runSearch(q) {
    const seq = ++searchSeq;
    $('search-results').hidden = false;
    $('search-title').textContent = `Results for "${q.slice(0, 60)}"`;
    $('search-list').textContent = '';
    $('search-status').hidden = false;
    $('search-status').textContent = 'Searching YouTube…';
    try {
      const p = new URLSearchParams({ part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '12', q, key: YT_KEY });
      const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${p}`);
      const j = await r.json();
      if (!r.ok) throw new Error(apiErrorText(j));
      const items = (j.items || []).filter((i) => i.id && i.id.videoId && i.snippet);
      const details = {};
      if (items.length) {
        const dp = new URLSearchParams({ part: 'contentDetails', id: items.map((i) => i.id.videoId).join(','), key: YT_KEY });
        const dr = await fetch(`https://www.googleapis.com/youtube/v3/videos?${dp}`);
        if (dr.ok) for (const v of (await dr.json()).items || []) details[v.id] = v;
      }
      if (seq !== searchSeq) return;
      const results = items.map((i) => {
        const v = details[i.id.videoId];
        const rating = v && v.contentDetails && v.contentDetails.contentRating;
        const th = i.snippet.thumbnails || {};
        return {
          id: i.id.videoId,
          title: decodeHtml(i.snippet.title),
          channel: decodeHtml(i.snippet.channelTitle),
          thumb: (th.medium || th.default || {}).url || '',
          duration: v ? isoDuration(v.contentDetails.duration) : '',
          live: i.snippet.liveBroadcastContent === 'live',
          age: !!(rating && rating.ytRating === 'ytAgeRestricted'),
        };
      });
      renderSearch(results);
    } catch (e) {
      if (seq !== searchSeq) return;
      $('search-status').hidden = false;
      $('search-status').textContent = (e && e.message) || 'YouTube search failed.';
    }
  }

  function renderSearch(results) {
    const list = $('search-list');
    list.textContent = '';
    $('search-status').hidden = results.length > 0;
    if (!results.length) $('search-status').textContent = 'No videos found. Try other words.';
    for (const r of results) {
      const li = document.createElement('li');
      li.className = 'sr';
      const thumb = document.createElement('div');
      thumb.className = 'sr-thumb';
      if (/^https:\/\/i\d?\.ytimg\.com\//.test(r.thumb)) {
        const img = document.createElement('img');
        img.src = r.thumb;
        img.alt = '';
        img.loading = 'lazy';
        thumb.appendChild(img);
      }
      if (r.live || r.duration) {
        const badge = document.createElement('span');
        badge.className = r.live ? 'sr-badge live' : 'sr-badge';
        badge.textContent = r.live ? 'LIVE' : r.duration;
        thumb.appendChild(badge);
      }
      const info = document.createElement('div');
      info.className = 'sr-info';
      const t = document.createElement('span');
      t.className = 'sr-title';
      t.textContent = r.title;
      t.title = r.title;
      const ch = document.createElement('span');
      ch.className = 'sr-channel';
      ch.textContent = r.channel;
      info.append(t, ch);
      if (r.age) {
        const note = document.createElement('p');
        note.className = 'sr-note';
        note.textContent = "Age-restricted: YouTube won't play it here. Open it on YouTube and use Share a tab.";
        info.append(note);
      } else {
        const actions = document.createElement('div');
        actions.className = 'sr-actions';
        const media = { raw: `https://www.youtube.com/watch?v=${r.id}`, title: r.title };
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'btn btn-primary';
        play.textContent = 'Play now';
        play.disabled = !canControl();
        play.addEventListener('click', () => { sendAction({ type: 'load', media }); closeSearch(); });
        const queue = document.createElement('button');
        queue.type = 'button';
        queue.className = 'btn btn-ghost';
        queue.textContent = 'Add to queue';
        queue.disabled = !canAdd();
        queue.addEventListener('click', () => {
          const had = !!room.media;
          sendAction({ type: 'enqueue', media });
          queue.textContent = 'Added';
          queue.disabled = true;
          if (had) toast('Added to the queue');
        });
        actions.append(play, queue);
        info.append(actions);
      }
      li.append(thumb, info);
      list.appendChild(li);
    }
  }
  function closeSearch() {
    searchSeq++;
    $('search-results').hidden = true;
    $('search-list').textContent = '';
  }
  $('search-close').addEventListener('click', closeSearch);

  // ---------- YouTube playlists ----------
  async function expandPlaylist(listId) {
    if (YT_KEY) {
      const out = [];
      let page = '';
      do {
        const params = new URLSearchParams({ part: 'snippet', maxResults: '50', playlistId: listId, key: YT_KEY });
        if (page) params.set('pageToken', page);
        const r = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`);
        const j = await r.json();
        if (!r.ok) throw new Error((j && j.error && j.error.message) || 'YouTube refused the request');
        for (const it of j.items || []) {
          const id = it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId;
          const title = it.snippet && it.snippet.title;
          if (id && title !== 'Private video' && title !== 'Deleted video') out.push({ id, title });
        }
        page = j.nextPageToken || '';
      } while (page && out.length < MAX_QUEUE);
      return out.slice(0, MAX_QUEUE);
    }
    // No API key: a hidden YouTube player can list a playlist's videos (titles get looked up after).
    await loadYouTubeApi();
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;';
      const inner = document.createElement('div');
      box.appendChild(inner);
      document.body.appendChild(box);
      let done = false;
      let hidden = null;
      const finish = (ids) => {
        if (done) return;
        done = true;
        try { if (hidden) hidden.destroy(); } catch { /* gone */ }
        box.remove();
        resolve((ids || []).slice(0, MAX_QUEUE).map((id) => ({ id })));
      };
      hidden = new YT.Player(inner, {
        width: 320, height: 180,
        playerVars: { listType: 'playlist', list: listId, autoplay: 0 },
        events: {
          onReady: () => {
            let tries = 0;
            const t = setInterval(() => {
              const ids = hidden.getPlaylist && hidden.getPlaylist();
              if ((ids && ids.length) || ++tries > 30) { clearInterval(t); finish(ids); }
            }, 200);
          },
          onError: () => finish([]),
        },
      });
      setTimeout(() => finish([]), 15000);
    });
  }

  async function addPlaylist(listId, mode) {
    toast('Loading the playlist…', 10000);
    let items = [];
    try { items = await expandPlaylist(listId); } catch (e) {
      return toast(`Couldn't load that playlist: ${(e && e.message) || 'unknown error'}.`, 6000);
    }
    if (!items.length) return toast("Couldn't read that playlist. It may be private or empty.", 6000);
    sendAction({
      type: mode === 'queue' ? 'enqueueMany' : 'loadMany',
      items: items.map((it) => ({ raw: `https://www.youtube.com/watch?v=${it.id}`, title: it.title || '' })),
    });
    toast(`Added ${items.length} video${items.length === 1 ? '' : 's'} from the playlist`, 4000);
  }

  $('next-btn').addEventListener('click', () => sendAction({ type: 'next' }));
  $('stage-error-next').addEventListener('click', () => sendAction({ type: 'next' }));

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim().slice(0, 400);
    if (!text) return;
    if (isHost) {
      const why = chatBlocked(myId);
      if (why) return toast(why, 4000);
      pushChat({ from: myId, name: myName, text, ts: Date.now() });
    } else if (hostConn && hostConn.open) hostConn.send({ t: 'chat', text });
    else return toast('Reconnecting to the room…');
    input.value = '';
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => {
        const on = t === tab;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', String(on));
      });
      for (const p of ['chat', 'queue', 'people']) $('panel-' + p).hidden = p !== name;
      if (name === 'chat') {
        tab.classList.remove('has-new');
        const list = $('chat-list');
        list.scrollTop = list.scrollHeight;
      }
    });
  });

  // ---------- invites ----------
  const inviteLink = () => `${location.origin}${location.pathname}#${code}`;
  const inviteText = () => (room.name ? `Join me in "${room.name}" on Watchroom! Room ${code}` : `Join me on Watchroom! Room ${code}`);
  const inviteMessage = () => `${inviteText()}: ${inviteLink()}`;

  function renderQR(text) {
    const box = $('invite-qr');
    box.textContent = '';
    if (typeof window.qrcode !== 'function') { box.parentElement.hidden = true; return; }
    const q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const pad = 2;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + pad},${r + pad}h1v1h-1z`;
    }
    const size = n + pad * 2;
    box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code for the invite link"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
  }

  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ($('invite-dialog').open ? $('invite-dialog') : document.body).appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
    ta.remove();
    return ok;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch { return legacyCopy(text); }
  }

  // Feedback inside the dialog (a toast would sit underneath it).
  function flash(btn, ok) {
    const label = btn.dataset.label || btn.textContent;
    btn.dataset.label = label;
    btn.textContent = ok ? 'Copied!' : 'Press Ctrl+C';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = label; }, 1600);
  }

  function openInvite() {
    if (!code) return;
    const link = inviteLink();
    $('invite-code').textContent = code;
    $('invite-link').value = link;
    $('invite-message').textContent = inviteMessage();
    $('invite-whatsapp').href = 'https://wa.me/?text=' + encodeURIComponent(inviteMessage());
    $('invite-telegram').href = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(inviteText());
    $('invite-native').hidden = typeof navigator.share !== 'function';
    $('invite-pass-note').hidden = !room.pass;
    renderQR(link);
    const d = $('invite-dialog');
    if (typeof d.showModal === 'function') {
      if (!d.open) d.showModal();
      $('invite-copy').focus();
    } else {
      copyText(link).then((ok) => toast(ok ? 'Invite link copied' : link, ok ? 2600 : 8000));
    }
  }

  $('invite-btn').addEventListener('click', openInvite);
  $('people-invite').addEventListener('click', openInvite);
  $('invite-copy').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await copyText(inviteLink());
    if (!ok) $('invite-link').select();
    flash(btn, ok);
  });
  $('invite-copy-msg').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    flash(btn, await copyText(inviteMessage()));
  });
  $('invite-native').addEventListener('click', () => {
    navigator.share({ title: 'Watchroom', text: inviteText(), url: inviteLink() }).catch(() => { /* closed */ });
  });
  $('invite-link').addEventListener('focus', (e) => e.target.select());
  $('invite-dialog').addEventListener('click', (e) => {
    // A click on the dimmed backdrop lands on the dialog element itself.
    if (e.target === e.currentTarget) e.currentTarget.close();
  });

  $('leave-btn').addEventListener('click', () => {
    saveSnapshot();
    leaving = true;
    stopLocalShare();
    if (hostConn && hostConn.open) { try { hostConn.send({ t: 'bye' }); } catch { /* ignore */ } }
    setTimeout(() => {
      try { if (peer) peer.destroy(); } catch { /* ignore */ }
      location.href = location.pathname;
    }, 120);
  });

  // Pasting an invite link into a tab that's already on the lobby: start over with that room.
  window.addEventListener('hashchange', () => {
    if (!$('lobby').hidden && normCode(location.hash.slice(1)).length === 6) location.reload();
  });

  window.addEventListener('pagehide', () => {
    if ($('lobby').hidden) saveSnapshot();
    leaving = true;
    stopLocalShare();
    if (hostConn && hostConn.open) { try { hostConn.send({ t: 'bye' }); } catch { /* ignore */ } }
    try { if (peer) peer.destroy(); } catch { /* ignore */ }
  });

  // Test hook, only with ?debug in the address.
  if (/[?&]debug\b/.test(location.search)) {
    window.__watchroom = { get room() { return room; }, ident, get isHost() { return isHost; }, get myId() { return myId; } };
  }

  // ---------- boot ----------
  (function boot() {
    const tag = $('build-tag');
    if (tag) tag.textContent = tag.dataset.build === '__BUILD__' ? 'dev' : tag.dataset.build;
    const saved = store.get('watchroom-name');
    if (saved) { $('name-input').value = saved; myName = cleanName(saved); }
    if (!window.Peer) {
      lobbyError('A required script failed to load. Check your connection or ad blocker, then reload.');
      $('create-btn').disabled = true;
      return;
    }
    let notice = null;
    try { notice = sessionStorage.getItem('watchroom-notice'); sessionStorage.removeItem('watchroom-notice'); } catch { /* ignore */ }
    if (notice) setTimeout(() => toast(notice, 6000), 300);
    if (hashCode.length !== 6 && saved) {
      showRoomsView();
      return;
    }
    if (hashCode.length === 6) {
      $('create-btn').textContent = `Join room ${hashCode}`;
      $('code-input').value = hashCode;
      document.querySelector('.or').hidden = true;
      document.querySelector('.join-row').hidden = true;
      const another = document.createElement('button');
      another.type = 'button';
      another.className = 'btn btn-ghost btn-wide';
      another.textContent = saved ? 'Go to my rooms instead' : 'Create a new room instead';
      another.addEventListener('click', () => {
        hashCode = '';
        history.replaceState(null, '', location.pathname);
        if (!readName()) return;
        if (saved) showRoomsView();
        else createRoomFlow();
      });
      $('create-btn').after(another);
    }
    (saved ? $('create-btn') : $('name-input')).focus();
  })();
})();
