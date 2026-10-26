// OG Royale lobby networking (runs in the launcher window, which stays open between matches).
// Players find each other through a public PeerJS signalling server, then talk directly over
// WebRTC data channels. The host is the hub: clients connect to the host, and the host relays.
(function () {
  const SIG = (window.ogr && ogr.cfg && ogr.cfg.signal) || 'wss://0.peerjs.com:443/peerjs';
  const PREFIX = 'ogroyale-v1-';
  const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  // Relay fallback (Open Relay by Metered, free public TURN). Used automatically when two
  // networks can't reach each other directly (school/work Wi-Fi, strict routers, same-network hairpin).
  const TURN_HOST = 'staticauth.openrelay.metered.ca', TURN_SECRET = 'openrelayprojectsecret';
  let ICE = STUN;
  async function iceServers() {
    try {
      const user = Math.floor(Date.now() / 1000 + 24 * 3600) + ':ogroyale';
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TURN_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(user));
      const cred = btoa(String.fromCharCode(...new Uint8Array(sig)));
      ICE = [...STUN, { urls: [`turn:${TURN_HOST}:80`, `turn:${TURN_HOST}:80?transport=tcp`, `turn:${TURN_HOST}:443`, `turns:${TURN_HOST}:443?transport=tcp`], username: user, credential: cred }];
    } catch (e) { ICE = STUN; }
    return ICE;
  }
  const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rnd = n => Array.from({ length: n }, () => ALPH[Math.random() * ALPH.length | 0]).join('');
  const MAX = 8;

  function signal(id, onMsg) {
    return new Promise((resolve, reject) => {
      const token = Math.random().toString(36).slice(2);
      let ws, hb, opened = false;
      try { ws = new WebSocket(`${SIG}?key=peerjs&id=${encodeURIComponent(id)}&token=${token}&version=1.5.4`); }
      catch (e) { reject(new Error('offline')); return; }
      const api = {
        send: m => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
        close: () => { clearInterval(hb); try { ws.close(); } catch (e) {} }
      };
      const to = setTimeout(() => { if (!opened) { api.close(); reject(new Error('offline')); } }, 12000);
      ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'OPEN') { opened = true; clearTimeout(to); hb = setInterval(() => api.send({ type: 'HEARTBEAT' }), 5000); resolve(api); return; }
        if (m.type === 'ID-TAKEN') { clearTimeout(to); api.close(); reject(new Error('taken')); return; }
        if (m.type === 'ERROR' && !opened) { clearTimeout(to); api.close(); reject(new Error('offline')); return; }
        onMsg(m);
      };
      ws.onerror = () => { if (!opened) { clearTimeout(to); reject(new Error('offline')); } };
      ws.onclose = () => { clearInterval(hb); if (!opened) { clearTimeout(to); reject(new Error('offline')); } else if (api.onclose) api.onclose(); };
    });
  }

  function mkPC(sig, dst) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const q = []; let ready = false;
    pc.onicecandidate = e => { if (e.candidate) sig.send({ type: 'CANDIDATE', dst, payload: { c: e.candidate.toJSON() } }); };
    pc.addCand = c => { if (ready) pc.addIceCandidate(c).catch(() => {}); else q.push(c); };
    pc.remoteReady = () => { ready = true; q.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {})); };
    return pc;
  }

  const Net = {
    role: null, code: null, me: null, players: [], ev: {}, inMatch: false,
    on(k, f) { this.ev[k] = f; },
    emit(k, ...a) { const f = this.ev[k]; if (f) try { f(...a); } catch (e) { console.error(e); } },
    profile: () => ({}),

    // ---------------- host ----------------
    async host() {
      this.leave(true);
      this.role = 'host'; this.me = 'p0'; this.peers = new Map(); this.seat = 1;
      await iceServers();
      let tries = 0;
      while (true) {
        this.code = rnd(4);
        try { this.sig = await signal(PREFIX + this.code, m => this._hostSig(m)); break; }
        catch (e) { if (e.message !== 'taken' || ++tries > 4) { this.role = null; throw e; } }
      }
      this.sig.onclose = () => { if (this.role === 'host') this._reopenSig(); };
      this.players = [{ id: 'p0', host: true, ...this.profile() }];
      this._lobby();
      return this.code;
    },
    async _reopenSig() {
      try { this.sig = await signal(PREFIX + this.code, m => this._hostSig(m)); this.sig.onclose = () => { if (this.role === 'host') this._reopenSig(); }; }
      catch (e) { setTimeout(() => { if (this.role === 'host') this._reopenSig(); }, 5000); }
    },
    async _hostSig(m) {
      const src = m.src;
      if (m.type === 'OFFER') {
        if (this.peers.size >= MAX - 1 || this.inMatch) { this.sig.send({ type: 'ANSWER', dst: src, payload: { full: this.inMatch ? 'match' : 'full' } }); return; }
        const old = this.peers.get(src); if (old) { try { old.pc.close(); } catch (e) {} }
        const pc = mkPC(this.sig, src), P = { pc, sid: src, id: null, ch: {} };
        this.peers.set(src, P);
        pc.ondatachannel = e => { const c = e.channel; P.ch[c.label] = c; c.onmessage = ev => this._hostMsg(P, ev.data); c.onclose = () => this._drop(P); };
        pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) this._drop(P); };
        try {
          await pc.setRemoteDescription(m.payload.sdp); pc.remoteReady();
          const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
          this.sig.send({ type: 'ANSWER', dst: src, payload: { sdp: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription } });
        } catch (e) { this._drop(P); }
      } else if (m.type === 'CANDIDATE') {
        const P = this.peers.get(src); if (P && m.payload && m.payload.c) P.pc.addCand(m.payload.c);
      }
    },
    _hostMsg(P, raw) {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.t === 'hello') {
        const mine = (window.ogr && ogr.cfg && ogr.cfg.build) | 0;
        if ((m.build | 0) !== mine) { this._send(P, { t: 'reject', why: (m.build | 0) < mine ? 'oldyou' : 'oldhost' }); setTimeout(() => this._drop(P), 1500); return; }
        if (!P.id) P.id = 'p' + (this.seat++);
        P.info = { id: P.id, name: String(m.name || 'Player').slice(0, 24), skin: m.skin | 0, bb: m.bb | 0, gl: m.gl | 0, lvl: m.lvl | 0 };
        this._send(P, { t: 'welcome', you: P.id, code: this.code });
        this._lobby();
      } else if (m.t === 'g' && P.id) {
        const msg = { from: P.id, d: m.d }, fast = !!m.f;
        if (!m.d.to || m.d.to === 'p0') ogr.toGame(msg);
        for (const Q of this.peers.values()) if (Q !== P && Q.id && (!m.d.to || m.d.to === Q.id)) this._send(Q, { t: 'g', from: P.id, d: m.d }, fast);
      } else if (m.t === 'prof' && P.info) {
        Object.assign(P.info, { name: String(m.name || 'Player').slice(0, 24), skin: m.skin | 0, bb: m.bb | 0, gl: m.gl | 0, lvl: m.lvl | 0 }); this._lobby();
      }
    },
    _drop(P) {
      if (!this.peers || !this.peers.has(P.sid) || this.peers.get(P.sid) !== P) return;
      this.peers.delete(P.sid); try { P.pc.close(); } catch (e) {}
      if (P.id) {
        ogr.toGame({ from: P.id, d: { t: 'gone' } });
        this._bcast({ t: 'g', from: P.id, d: { t: 'gone' } });
      }
      this._lobby();
    },
    _send(P, m, fast) {
      const c = (fast && P.ch.fast && P.ch.fast.readyState === 'open') ? P.ch.fast : P.ch.rel;
      if (c && c.readyState === 'open') { try { c.send(JSON.stringify(m)); } catch (e) {} }
    },
    _bcast(m, fast) { if (this.peers) for (const P of this.peers.values()) if (P.id) this._send(P, m, fast); },
    _lobby() {
      if (this.role !== 'host') return;
      this.players = [{ id: 'p0', host: true, ...this.profile() }, ...[...this.peers.values()].filter(P => P.info).map(P => P.info)];
      this._bcast({ t: 'lobby', code: this.code, players: this.players, inMatch: this.inMatch });
      this.emit('lobby', this.players);
    },
    start() {
      if (this.role !== 'host') return;
      this.players = [{ id: 'p0', host: true, ...this.profile() }, ...[...this.peers.values()].filter(P => P.info).map(P => P.info)];
      const n = this.players.length;
      const info = { seed: (Math.random() * 4294967295) >>> 0, spawn: Math.random() * 5 | 0, busA: Math.random() * 6.283,
        bots: Math.max(5, 20 - n), players: this.players, hostId: 'p0', mid: rnd(6) };
      this._bcast({ t: 'start', info });
      this.inMatch = true; this._lobby();
      this.emit('start', { ...info, me: 'p0', host: true });
    },
    matchOver() {
      if (this.role === 'host') { this.inMatch = false; this._lobby(); }
      this.toAll({ t: 'gone' });
    },
    updateProfile() {
      if (this.role === 'host') this._lobby();
      else if (this.role === 'client' && this.ch && this.ch.rel && this.ch.rel.readyState === 'open') this.ch.rel.send(JSON.stringify({ t: 'prof', ...this.profile() }));
    },

    // ---------------- client ----------------
    async join(code) {
      this.leave(true);
      code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 4) throw new Error('code');
      this.role = 'client'; this.code = code; this.ch = {};
      await iceServers();
      const sid = PREFIX + 'c-' + rnd(10), dst = PREFIX + code;
      let pc, done = false, answered = false;
      return new Promise(async (resolve, reject) => {
        const fail = err => { if (done) return; done = true; this.leave(true); reject(err); };
        const tmo = setTimeout(() => fail(new Error(answered ? 'nat' : 'noanswer')), 30000);
        try {
          this.sig = await signal(sid, async m => {
            if (m.type === 'ANSWER' && m.payload) {
              if (m.payload.full) { clearTimeout(tmo); fail(new Error(m.payload.full)); return; }
              answered = true;
              try { await pc.setRemoteDescription(m.payload.sdp); pc.remoteReady(); } catch (e) { fail(new Error('timeout')); }
            } else if (m.type === 'CANDIDATE' && m.payload && m.payload.c) pc.addCand(m.payload.c);
            else if (m.type === 'EXPIRE' || m.type === 'LEAVE') { clearTimeout(tmo); fail(new Error('notfound')); }
          });
        } catch (e) { clearTimeout(tmo); fail(e); return; }
        pc = this.pc = mkPC(this.sig, dst);
        const rel = pc.createDataChannel('rel'), fast = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
        this.ch = { rel, fast };
        const onm = ev => this._clientMsg(ev.data);
        rel.onmessage = onm; fast.onmessage = onm;
        rel.onopen = () => { rel.send(JSON.stringify({ t: 'hello', build: (window.ogr && ogr.cfg && ogr.cfg.build) | 0, ...this.profile() })); };
        this._failJoin = e => { clearTimeout(tmo); fail(e); };
        rel.onclose = () => { if (this.role === 'client' && done) { this.emit('closed', 'The host closed the lobby.'); ogr.toGame({ from: 'p0', d: { t: 'gone' } }); this.leave(true); } };
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') { if (!done) { clearTimeout(tmo); fail(new Error('nat')); } else rel.onclose(); } };
        this._welcome = info => { if (done) return; done = true; clearTimeout(tmo); try { this.sig.close(); } catch (e) {} this.sig = null; resolve(info); };
        try {
          const off = await pc.createOffer(); await pc.setLocalDescription(off);
          this.sig.send({ type: 'OFFER', dst, payload: { sdp: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription } });
        } catch (e) { clearTimeout(tmo); fail(e); }
      });
    },
    _clientMsg(raw) {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.t === 'reject') { if (this._failJoin) this._failJoin(new Error(m.why)); return; }
      if (m.t === 'welcome') { this.me = m.you; if (this._welcome) this._welcome(m); }
      else if (m.t === 'lobby') { this.players = m.players; this.inMatch = m.inMatch; this.emit('lobby', m.players); }
      else if (m.t === 'start') { this.inMatch = true; this.emit('start', { ...m.info, me: this.me, host: false }); }
      else if (m.t === 'g') ogr.toGame({ from: m.from, d: m.d });
    },

    // ---------------- both ----------------
    fromGame(m) {
      if (!m || !m.d) return;
      if (this.role === 'host') {
        const d = m.d;
        for (const P of this.peers.values()) if (P.id && (!d.to || d.to === P.id)) this._send(P, { t: 'g', from: 'p0', d }, !!m.f);
      } else if (this.role === 'client' && this.ch && this.ch.rel) {
        const c = (m.f && this.ch.fast.readyState === 'open') ? this.ch.fast : this.ch.rel;
        if (c.readyState === 'open') try { c.send(JSON.stringify({ t: 'g', d: m.d, f: m.f })); } catch (e) {}
      }
    },
    toAll(d) { this.fromGame({ d, f: 0 }); },
    leave(silent) {
      const was = this.role;
      if (this.sig) { try { this.sig.close(); } catch (e) {} this.sig = null; }
      if (this.peers) { for (const P of this.peers.values()) try { P.pc.close(); } catch (e) {} this.peers = null; }
      if (this.pc) { try { this.pc.close(); } catch (e) {} this.pc = null; }
      this.role = null; this.code = null; this.me = null; this.players = []; this.inMatch = false; this.ch = null;
      if (was && !silent) this.emit('left');
    }
  };
  window.NET = Net;
  if (window.ogr && ogr.onFromGame) ogr.onFromGame(m => Net.fromGame(m));
})();
