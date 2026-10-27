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
    return { media: null, playing: false, pos: 0, at: 0, rate: 1, queue: [], users: [], share: null };
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
  function cleanName(n) {
    return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Guest';
  }
  function mediaLabel(m) {
    return m.title || (m.kind === 'youtube' ? 'a YouTube video' : 'a video');
  }
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
    if (/^[\w-]{11}$/.test(s)) {
      return { kind: 'youtube', ytId: s, src: `https://www.youtube.com/watch?v=${s}`, start: 0 };
    }
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    const isYT = host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com';
    if (isYT) {
      let id = null;
      if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
      else if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
        if (m) id = m[1];
      }
      if (!id || !/^[\w-]{11}$/.test(id)) return null;
      const start = parseTime(u.searchParams.get('t') || u.searchParams.get('start'));
      return { kind: 'youtube', ytId: id, src: `https://www.youtube.com/watch?v=${id}`, start };
    }

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

  const player = {
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
        $('yt-wrap').hidden = true;
        $('stage-empty').hidden = false;
        this.kind = null;
        return;
      }
      $('stage-empty').hidden = true;

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
      if (this.kind === 'youtube' && this.yt) {
        try { this.yt.playVideo(); } catch { /* ignore */ }
      } else if (this.kind === 'video') {
        const p = video.play();
        if (p && p.catch) p.catch(() => { if (room.playing && !this.errored) $('unmute-overlay').hidden = false; });
      }
    },
    pause() {
      if (this.kind === 'youtube' && this.yt) { try { this.yt.pauseVideo(); } catch { /* ignore */ } }
      else if (this.kind === 'video') video.pause();
    },
    seek(t) {
      t = Math.max(0, t);
      if (this.kind === 'youtube' && this.yt) { try { this.yt.seekTo(t, true); } catch { /* ignore */ } }
      else if (this.kind === 'video') { try { video.currentTime = t; } catch { /* not seekable yet */ } }
    },
    getTime() {
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
      if (this.kind === 'youtube') { const s = this.state(); return s === 1 || s === 3; }
      if (this.kind === 'video') return !video.paused && !video.ended;
      return false;
    },
    hasTime() {
      if (this.kind === 'youtube') { const s = this.state(); return s === 1 || s === 2 || s === 3; }
      if (this.kind === 'video') return video.readyState >= 1;
      return false;
    },
    isBuffering() {
      if (this.kind === 'youtube') return this.state() === 3;
      if (this.kind === 'video') return video.readyState < 3 && !video.paused;
      return false;
    },
    title() {
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
    if (ytLink && /^https:\/\/www\.youtube\.com\//.test(ytLink)) { a.href = ytLink; a.hidden = false; }
    else a.hidden = true;
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
    if (room.playing) {
      if ((fresh && Math.abs(cur - exp) > 0.5) || Math.abs(cur - exp) > DRIFT) {
        player.suppress(); player.seek(exp); player.lastFix = Date.now();
      }
      if (!player.isPlaying()) {
        player.suppress(); player.play();
        checkBlockedSoon();
      }
    } else {
      if (player.isPlaying()) { player.suppress(); player.pause(); }
      if (fresh && player.kind === 'youtube' && !player.hasTime()) return;
      if (Math.abs(cur - room.pos) > 0.5) {
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
      if (room.share || !room.playing || !room.media || room.media.uid !== mid || player.errored || !player.ready) return;
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
    if (!room.media) return;
    if (Math.abs(t - expectedPos()) < DRIFT + 0.5) return;
    sendAction({ type: 'seek', pos: t });
  }
  function onPlayerEnded() {
    if (!isHost || !room.media || !room.playing) return;
    handleAction(myId, { type: 'next', mid: room.media.uid, auto: true });
  }

  const reportedTitles = new Set();
  function tick() {
    if (room.share) return;
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

  async function startShare() {
    if (!canShare) {
      toast('Sharing needs Chrome, Edge or Firefox on a computer. You can still watch shares on this device.', 5000);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
      });
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return; // picker cancelled
      toast("Couldn't start sharing. Check that your browser is allowed to share the screen.", 5000);
      return;
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
    call.answer();
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
          const c = peer.call(id, localShare, { metadata: { sid: s.sid } });
          if (!c) continue;
          c._sid = s.sid;
          outCalls.set(id, c);
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

  function rebuildUsers() {
    const list = [{ id: myId, name: myName, host: true }];
    [...guests.entries()]
      .filter(([, g]) => g.ready)
      .sort((a, b) => a[1].joined - b[1].joined)
      .forEach(([id, g]) => list.push({ id, name: g.name, host: false }));
    room.users = list;
  }

  function setMedia(m) {
    room.media = m;
    room.pos = m.start || 0;
    room.at = hostNow();
    room.playing = true;
  }

  function hostMediaFrom(a, by) {
    const m = parseMedia(a && a.media && a.media.raw);
    if (!m) return null;
    m.uid = uid();
    m.by = cleanName(by);
    m.titleSet = m.kind === 'video';
    if (m.kind === 'youtube') fetchTitle(m);
    return m;
  }

  function handleAction(from, a) {
    if (!a || typeof a !== 'object') return;
    const who = nameOf(from);
    const cur = room.media;
    const pos = Math.max(0, Number(a.pos) || 0);

    if (['play', 'pause', 'seek'].includes(a.type) && (!cur || a.mid !== cur.uid)) return;

    switch (a.type) {
      case 'play':
        room.pos = pos; room.at = hostNow(); room.playing = true;
        systemMsg(`${who} pressed play`);
        break;
      case 'pause':
        room.pos = pos; room.at = hostNow(); room.playing = false;
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
        if (!a.auto) room.share = null;
        const next = room.queue.shift();
        if (next) {
          setMedia(next);
          if (!a.auto) systemMsg(`${who} skipped to ${mediaLabel(next)}`);
        } else if (a.auto && cur) {
          room.playing = false; room.pos = pos || room.pos; room.at = hostNow();
        } else {
          room.media = null; room.playing = false; room.pos = 0; room.at = hostNow();
          if (cur) systemMsg(`${who} cleared the player`);
        }
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

  async function fetchTitle(m) {
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
      guests.set(conn.peer, { conn, name: 'Guest', lastSeen: Date.now(), joined: Date.now(), ready: false });
    });
    conn.on('data', (d) => {
      if (!d || typeof d !== 'object') return;
      const g = guests.get(conn.peer);
      if (!g) return;
      g.lastSeen = Date.now();
      switch (d.t) {
        case 'hello':
          if (g.ready) return;
          g.name = cleanName(d.name);
          g.ready = true;
          rebuildUsers();
          conn.send({ t: 'welcome', you: conn.peer, chat: chat.slice(-100) });
          systemMsg(`${g.name} joined`);
          broadcastState();
          break;
        case 'ping':
          conn.send({ t: 'pong', c: d.c, h: Date.now() });
          break;
        case 'action':
          if (g.ready) handleAction(conn.peer, d.a);
          break;
        case 'chat': {
          const text = String(d.text || '').trim().slice(0, 400);
          if (g.ready && text) pushChat({ from: conn.peer, name: g.name, text, ts: Date.now() });
          break;
        }
        case 'title':
          if (typeof d.title === 'string' && d.title) setTitle(d.mid, d.title);
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

  function dropGuest(id) {
    const g = guests.get(id);
    if (!g) return;
    guests.delete(id);
    try { g.conn.close(); } catch { /* already closed */ }
    if (g.ready) {
      systemMsg(`${g.name} left`);
      if (room.share && room.share.peer === id) room.share = null;
      broadcastState();
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
      conn.send({ t: 'hello', name: myName });
      for (let i = 0; i < 4; i++) setTimeout(sendPing, 150 * i);
      setConnected(true);
    });
    conn.on('data', onHostData);
    conn.on('close', () => { if (hostConn === conn) onHostLost(); });
    conn.on('error', () => { if (hostConn === conn) onHostLost(); else fail('error'); });
  }

  function sendPing() {
    if (hostConn && hostConn.open) { try { hostConn.send({ t: 'ping', c: Date.now() }); } catch { /* ignore */ } }
  }

  function onHostData(d) {
    if (!d || typeof d !== 'object') return;
    switch (d.t) {
      case 'welcome':
        chat = Array.isArray(d.chat) ? d.chat.slice(-MAX_CHAT) : [];
        renderAllChat();
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
      kind: m.kind === 'youtube' ? 'youtube' : 'video',
      src: String(m.src || ''),
      ytId: typeof m.ytId === 'string' && /^[\w-]{11}$/.test(m.ytId) ? m.ytId : null,
      title: typeof m.title === 'string' ? m.title.slice(0, 200) : '',
      titleSet: !!m.titleSet,
      by: cleanName(m.by),
      start: Math.max(0, Number(m.start) || 0),
    };
    if (!/^https?:\/\//i.test(out.src)) return null;
    if (out.kind === 'youtube' && !out.ytId) return null;
    return out;
  }
  function sanitizeRoom(r) {
    return {
      media: sanitizeMedia(r.media),
      playing: !!r.playing,
      pos: Math.max(0, Number(r.pos) || 0),
      at: Number(r.at) || 0,
      rate: Number(r.rate) || 1,
      queue: Array.isArray(r.queue) ? r.queue.slice(0, MAX_QUEUE).map(sanitizeMedia).filter(Boolean) : [],
      users: Array.isArray(r.users)
        ? r.users.slice(0, 100).map((u) => ({ id: String(u && u.id || ''), name: cleanName(u && u.name), host: !!(u && u.host) }))
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
    if (leaving || isHost || migrating) return;
    migrating = true;
    if (hostConn) { try { hostConn.close(); } catch { /* ignore */ } hostConn = null; }
    setConnected(false, 'Host left · reconnecting');

    const lastRoom = room;
    const others = lastRoom.users.filter((u) => !u.host);
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
    room = { ...lastRoom, pos, at: Date.now(), users: [], share };
    for (const c of outCalls.values()) { try { c.close(); } catch { /* ignore */ } }
    outCalls.clear();
    closeView();
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

  function startHost(withCode) {
    code = withCode || genCode();
    const p = new Peer(PEER_PREFIX + code, PEER_OPTIONS);
    peer = p;
    let opened = false;
    p.on('open', (id) => {
      opened = true;
      isHost = true;
      myId = id;
      room = emptyRoom();
      enterRoom();
      setConnected(true);
      systemMsg(`${myName} opened the room`);
      broadcastState();
    });
    p.on('error', (err) => {
      if (!opened) {
        try { p.destroy(); } catch { /* ignore */ }
        if (err.type === 'unavailable-id') {
          if (withCode) return lobbyError(`Room ${withCode} is already open. Join it instead.`);
          return startHost();
        }
        return lobbyError(peerErrorText(err));
      }
      onPeerError(err);
    });
    p.on('connection', onGuestConnection);
    p.on('call', onIncomingCall);
    p.on('disconnected', () => { if (!p.destroyed && !leaving) try { p.reconnect(); } catch { /* ignore */ } });
  }

  function startGuest(roomCode) {
    code = roomCode;
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
        if (why === 'not-found') lobbyError(`Nobody is in room ${roomCode} right now.`, roomCode);
        else lobbyError("Couldn't connect to the room. Some networks block peer-to-peer connections; try another network or ask the host for a new link.");
      });
      // Show the room as soon as the connection opens.
      const wait = setInterval(() => {
        if (hostConn) { clearInterval(wait); enterRoom(); }
        else if (!peer) clearInterval(wait);
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
    $('lobby').hidden = true;
    $('room').hidden = false;
    $('room-code').textContent = code;
    document.title = `${code} · Watchroom`;
    if (location.hash.slice(1) !== code) history.replaceState(null, '', '#' + code);
    render();
    renderAllChat();
  }

  function render() {
    const m = room.media;
    if (room.share) {
      $('now-title').textContent = room.share.peer === myId ? 'Your tab' : `${room.share.name}'s tab`;
      $('now-by').textContent = 'Live tab share';
    } else {
      $('now-title').textContent = m ? (m.title || (m.kind === 'youtube' ? 'YouTube video' : 'Video')) : 'Nothing playing';
      $('now-by').textContent = m ? `Added by ${m.by}` : '';
    }
    renderShare();
    reconcileShare();
    $('next-btn').disabled = room.queue.length === 0;
    $('stage-error-next').textContent = room.queue.length ? 'Skip to next' : 'Clear player';
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
      title.textContent = q.title || (q.kind === 'youtube' ? 'YouTube video' : 'Video');
      title.title = title.textContent;
      const sub = document.createElement('span');
      sub.className = 'q-sub';
      sub.textContent = `${q.kind === 'youtube' ? 'YouTube' : 'Video file'} · ${q.by}`;
      main.append(title, sub);

      const actions = document.createElement('div');
      actions.className = 'q-actions';
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
    const users = room.users.length ? room.users : [{ id: myId, name: myName, host: isHost }];
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
      li.append(av, nm);
      if (u.host) li.append(tag('Host', true));
      if (u.id === myId) li.append(tag('You'));
      list.appendChild(li);
    }
  }
  function tag(text, host) {
    const t = document.createElement('span');
    t.className = host ? 'tag tag-host' : 'tag';
    t.textContent = text;
    return t;
  }

  function chatNode(m) {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = clock(Number(m.ts) || Date.now());
    if (m.system) {
      li.className = 'msg-system';
      const text = document.createElement('span');
      text.textContent = String(m.text || '');
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
    text.textContent = String(m.text || '').slice(0, 400);
    li.append(head, text);
    return li;
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
    const el = $('lobby-error');
    el.textContent = text + ' ';
    if (offerCode) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost btn-sm';
      b.textContent = `Open room ${offerCode} yourself`;
      b.addEventListener('click', () => {
        if (!readName()) return;
        setLobbyBusy(true);
        startHost(offerCode);
      });
      el.appendChild(b);
    }
    el.hidden = false;
  }

  function setLobbyBusy(busy) {
    $('create-btn').disabled = busy;
    $('join-btn').disabled = busy;
    if (busy) $('lobby-error').hidden = true;
  }

  // ---------- actions out ----------
  function sendAction(a) {
    if (!('mid' in a)) a.mid = room.media ? room.media.uid : null;
    if (isHost) handleAction(myId, a);
    else if (hostConn && hostConn.open) hostConn.send({ t: 'action', a });
    else toast('Reconnecting to the room…');
  }

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
    setLobbyBusy(true);
    if (hashCode.length === 6) startGuest(hashCode);
    else startHost();
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
    const m = parseMedia(raw);
    if (!m) {
      toast("That isn't a YouTube video link or a direct video file link.", 3500);
      return;
    }
    const queued = mode === 'queue' && !!room.media;
    sendAction({ type: mode === 'queue' ? 'enqueue' : 'load', media: { raw } });
    $('url-input').value = '';
    if (queued) toast('Added to the queue');
  });

  $('next-btn').addEventListener('click', () => sendAction({ type: 'next' }));
  $('stage-error-next').addEventListener('click', () => sendAction({ type: 'next' }));

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim().slice(0, 400);
    if (!text) return;
    if (isHost) pushChat({ from: myId, name: myName, text, ts: Date.now() });
    else if (hostConn && hostConn.open) hostConn.send({ t: 'chat', text });
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

  $('invite-btn').addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}#${code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied');
    } catch {
      toast(link, 6000);
    }
  });

  $('leave-btn').addEventListener('click', () => {
    leaving = true;
    stopLocalShare();
    if (hostConn && hostConn.open) { try { hostConn.send({ t: 'bye' }); } catch { /* ignore */ } }
    setTimeout(() => {
      try { if (peer) peer.destroy(); } catch { /* ignore */ }
      location.href = location.pathname;
    }, 120);
  });

  window.addEventListener('pagehide', () => {
    leaving = true;
    stopLocalShare();
    if (hostConn && hostConn.open) { try { hostConn.send({ t: 'bye' }); } catch { /* ignore */ } }
    try { if (peer) peer.destroy(); } catch { /* ignore */ }
  });

  // ---------- boot ----------
  (function boot() {
    const saved = store.get('watchroom-name');
    if (saved) $('name-input').value = saved;
    if (!window.Peer) {
      lobbyError('A required script failed to load. Check your connection or ad blocker, then reload.');
      $('create-btn').disabled = true;
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
      another.textContent = 'Create a new room instead';
      another.addEventListener('click', () => {
        hashCode = '';
        history.replaceState(null, '', location.pathname);
        if (!readName()) return;
        setLobbyBusy(true);
        startHost();
      });
      $('create-btn').after(another);
    }
    (saved ? $('create-btn') : $('name-input')).focus();
  })();
})();
