// OG Royale lobby networking (runs in the launcher window, which stays open between matches).
// Lobbies are found and joined through a free public MQTT relay (works on almost any network).
// For low ping, each joiner then tries a direct WebRTC link to the host; if that works, match
// traffic goes direct, otherwise it stays on the relay. The host routes everything (star layout).
// Traffic is bundled every 50 ms, position updates are de-duplicated (only the newest is sent) and
// dropped rather than queued when a connection backs up, so delay can never pile up.
(function () {
  const CFG = (window.ogr && ogr.cfg) || {};
  const LOCAL = /^wss?:\/\/127\.0\.0\.1/.test(CFG.signal || '');
  const BROKERS = LOCAL ? CFG.signal.split(',').map(url => ({ url })) : [
    { url: 'wss://broker.emqx.io:8084/mqtt' },
    { url: 'wss://broker.hivemq.com:8884/mqtt' },
    { url: 'wss://public.cloud.shiftr.io', user: 'public', pass: 'public' },
    { url: 'wss://test.mosquitto.org:8081' }
  ];
  const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const TURN_HOST = 'staticauth.openrelay.metered.ca', TURN_SECRET = 'openrelayprojectsecret';
  let ICE = STUN;
  async function iceServers() {
    if (LOCAL) return (ICE = []);
    try {
      const user = Math.floor(Date.now() / 1000 + 24 * 3600) + ':ogroyale';
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TURN_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(user));
      ICE = [...STUN, { urls: [`turn:${TURN_HOST}:80`, `turn:${TURN_HOST}:443`, `turns:${TURN_HOST}:443?transport=tcp`], username: user, credential: btoa(String.fromCharCode(...new Uint8Array(sig))) }];
    } catch (e) { ICE = STUN; }
    return ICE;
  }
  const ROOT = 'ogroyale/v3/';
  const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rnd = n => Array.from({ length: n }, () => ALPH[Math.random() * ALPH.length | 0]).join('');
  const MAX = 8, BUILD = (CFG.build | 0), FLUSH_MS = 50;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const FAST = new Set(['s', 'bs', 'trc']);          // replaceable / droppable
  const LATEST = new Set(['s', 'bs']);               // only the newest per sender matters

  // ---------------- minimal MQTT 3.1.1 client (QoS 0) over WebSocket ----------------
  function mqtt(broker, clientId, will, onMsg, timeoutMs) {
    return new Promise((resolve, reject) => {
      let ws, buf = new Uint8Array(0), done = false, ping, pid = 1;
      const fail = e => { if (done) return; done = true; clearTimeout(to); try { ws.close(); } catch (x) {} reject(e); };
      const to = setTimeout(() => fail(new Error('offline')), timeoutMs || 6000);
      const vlen = n => { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; o.push(b); } while (n > 0); return o; };
      const str = s => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
      const pkt = (h, body) => new Uint8Array([h, ...vlen(body.length), ...body]);
      const send = p => { if (ws && ws.readyState === 1) ws.send(p); };
      const api = {
        sub: t => send(pkt(0x82, [pid >> 8, pid++ & 255, ...str(t), 0])),
        pub: (t, s, retain) => { const p = enc.encode(s); const v = str(t); const body = new Uint8Array(v.length + p.length); body.set(v); body.set(p, v.length); const h = vlen(body.length); const out = new Uint8Array(1 + h.length + body.length); out[0] = 0x30 | (retain ? 1 : 0); out.set(h, 1); out.set(body, 1 + h.length); send(out); },
        backed: () => ws && ws.bufferedAmount > 96 * 1024,
        close: () => { clearInterval(ping); try { send(new Uint8Array([0xe0, 0])); ws.close(); } catch (e) {} },
        onclose: null, url: broker.url
      };
      try { ws = new WebSocket(broker.url, 'mqtt'); } catch (e) { fail(new Error('offline')); return; }
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        let flags = 0x02, pay = [...str(clientId)];
        if (will) { flags |= 0x04 | (will.retain ? 0x20 : 0); pay.push(...str(will.topic), ...str(will.msg)); }
        if (broker.user) { flags |= 0x80; pay.push(...str(broker.user)); }
        if (broker.pass) { flags |= 0x40; pay.push(...str(broker.pass)); }
        send(pkt(0x10, [...str('MQTT'), 4, flags, 0, 30, ...pay]));
      };
      ws.onmessage = ev => {
        const a = new Uint8Array(ev.data), m = new Uint8Array(buf.length + a.length); m.set(buf); m.set(a, buf.length); buf = m;
        while (buf.length >= 2) {
          let mul = 1, len = 0, i = 1, b;
          do { if (i >= buf.length) return; b = buf[i++]; len += (b & 127) * mul; mul *= 128; } while (b & 128);
          if (buf.length < i + len) return;
          const type = buf[0] >> 4, qos = (buf[0] >> 1) & 3, body = buf.subarray(i, i + len);
          buf = buf.slice(i + len);
          if (type === 2) { if (body[1] !== 0) { fail(new Error('offline')); return; } done = true; clearTimeout(to); ping = setInterval(() => send(new Uint8Array([0xc0, 0])), 20000); resolve(api); }
          else if (type === 3) { const tl = (body[0] << 8) | body[1]; const topic = dec.decode(body.subarray(2, 2 + tl)); const off = 2 + tl + (qos ? 2 : 0); try { onMsg(topic, dec.decode(body.subarray(off))); } catch (e) { console.error(e); } }
        }
      };
      ws.onerror = () => fail(new Error('offline'));
      ws.onclose = () => { clearInterval(ping); if (!done) fail(new Error('offline')); else if (api.onclose) api.onclose(); };
    });
  }
  async function anyBroker(clientId, will, onMsg) {
    for (const b of BROKERS) { try { return await mqtt(b, clientId, will, onMsg, 6000); } catch (e) {} }
    throw new Error('offline');
  }

  // ---------------- outgoing queue per link: bundle, keep newest positions, drop when backed up ----------------
  function mkQueue() { return { rel: [], fast: [], latest: new Map() }; }
  function qPush(q, from, d, fast) {
    if (fast && LATEST.has(d.t)) q.latest.set(from + ':' + d.t, [from, d, 1]);
    else if (fast) { q.fast.push([from, d, 1]); if (q.fast.length > 40) q.fast.splice(0, q.fast.length - 40); }
    else q.rel.push([from, d, 0]);
  }
  function qTake(q, backed) {
    const rel = q.rel.splice(0), fast = backed ? [] : [...q.latest.values(), ...q.fast];
    q.latest.clear(); q.fast.length = 0;
    return { rel, fast };
  }

  // ---------------- direct WebRTC link (signalled over the relay) ----------------
  function mkPC(sendSig) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const q = []; let ready = false;
    pc.onicecandidate = e => { if (e.candidate) sendSig({ t: 'ice', c: e.candidate.toJSON() }); };
    pc.addCand = c => { if (ready) pc.addIceCandidate(c).catch(() => {}); else q.push(c); };
    pc.remoteReady = () => { ready = true; q.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {})); };
    return pc;
  }
  const dcOpen = L => L && L.dcF && L.dcR && L.dcF.readyState === 'open' && L.dcR.readyState === 'open';

  const Net = {
    role: null, code: null, me: null, players: [], ev: {}, inMatch: false,
    on(k, f) { this.ev[k] = f; },
    emit(k, ...a) { const f = this.ev[k]; if (f) try { f(...a); } catch (e) { console.error(e); } },
    profile: () => ({}),
    T(x) { return ROOT + this.code + '/' + x; },
    send(topic, m, retain, via) { const q = via || this.mq; if (!q) return; q.pub(this.T(topic), m === '' ? '' : JSON.stringify(m), retain); },
    sendAll(topic, m, retain) { for (const q of (this.mqs && this.mqs.length ? this.mqs : [this.mq])) if (q) this.send(topic, m, retain, q); },
    stat() { return { ms: this.rtt == null ? null : Math.round(this.rtt), via: this.role === 'host' ? 'host' : (dcOpen(this.link) ? 'direct' : 'relay') }; },

    // ---------------- host ----------------
    async host() {
      this.leave(true);
      await iceServers();
      this.role = 'host'; this.me = 'p0'; this.peers = new Map(); this.inMatch = false;
      this.code = rnd(4);
      // list the lobby on every relay we can reach, so friends whose network blocks one still find it
      const will = { topic: ROOT + this.code + '/lobby', msg: '', retain: true }, cid = 'ogr' + rnd(10);
      const tries = await Promise.allSettled(BROKERS.map(b => { let q; return mqtt(b, cid, will, (t, s) => this._hostRx(t, s, q), 6000).then(x => (q = x)); }));
      this.mqs = tries.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (!this.mqs.length) { this.role = null; throw new Error('offline'); }
      this.mq = this.mqs[0];
      for (const q of this.mqs) {
        q.sub(this.T('h')); q.sub(this.T('a'));
        q.onclose = () => { if (this.role !== 'host') return; this.mqs = this.mqs.filter(x => x !== q); if (this.mq === q) this.mq = this.mqs[0] || null;
          if (!this.mqs.length) { this.emit('closed', 'Lost the connection to the online service. Create the lobby again.'); this.leave(true); } };
      }
      this.players = [{ id: 'p0', host: true, ...this.profile() }];
      this._lobby();
      this._hb = setInterval(() => this._sweep(), 3000);
      this._fl = setInterval(() => this._flushHost(), FLUSH_MS);
      this._ns = setInterval(() => { if (!this.peers) return; let d = 0, r = 0; for (const P of this.peers.values()) if (P.info) dcOpen(P) ? d++ : r++; ogr.toGame({ from: 'net', d: { t: 'netstat', via: 'host', direct: d, relay: r } }); }, 2000);
      return this.code;
    },
    _hostRx(t, s, mq) {
      if (!this.code || !s) return;
      let m; try { m = JSON.parse(s); } catch (e) { return; }
      const from = m.from; if (!from || from === 'p0') return;
      if (t === this.T('h')) {
        let P = this.peers.get(from);
        if (m.t === 'hello') {
          if ((m.build | 0) !== BUILD) { this.send('c/' + from, { t: 'reject', why: (m.build | 0) < BUILD ? 'oldyou' : 'oldhost' }, false, mq); return; }
          if (this.inMatch) { this.send('c/' + from, { t: 'reject', why: 'match' }, false, mq); return; }
          if (!P && this.peers.size >= MAX - 1) { this.send('c/' + from, { t: 'reject', why: 'full' }, false, mq); return; }
          P = P || { id: from, q: mkQueue() }; P.seen = Date.now(); P.mq = mq;
          P.info = { id: from, name: String(m.name || 'Player').slice(0, 24), skin: m.skin | 0, bb: m.bb | 0, gl: m.gl | 0, lvl: m.lvl | 0 };
          this.peers.set(from, P);
          this.send('c/' + from, { t: 'welcome', you: from, code: this.code }, false, mq);
          this._lobby();
          return;
        }
        if (!P) return;
        P.seen = Date.now();
        if (m.t === 'prof') { Object.assign(P.info, { name: String(m.name || 'Player').slice(0, 24), skin: m.skin | 0, bb: m.bb | 0, gl: m.gl | 0, lvl: m.lvl | 0 }); this._lobby(); }
        else if (m.t === 'bye') this._drop(from);
        else if (m.t === 'pi') this.send('c/' + from, { t: 'po', ts: m.ts }, false, P.mq);
        else if (m.t === 'B') this._hostBundle(P, m);
        else if (m.t === 'rtc') this._hostRtc(P, m);
        else if (m.t === 'ice') { if (P.pc && m.c) P.pc.addCand(m.c); }
      } else if (t === this.T('a') && m.t === 'g' && m.d && m.d.t === 'gone') {
        const P = this.peers.get(from);
        if (P && !this.inMatch) this._drop(from); else if (P) { this._route(from, m.d, false); ogr.toGame({ from, d: m.d }); }
      }
    },
    async _hostRtc(P, m) {
      try {
        if (P.pc) try { P.pc.close(); } catch (e) {}
        const pc = P.pc = mkPC(x => this.send('c/' + P.id, x, false, P.mq));
        pc.ondatachannel = e => {
          const c = e.channel; if (c.label === 'f') P.dcF = c; else P.dcR = c;
          c.onmessage = ev => { let b; try { b = JSON.parse(ev.data); } catch (x) { return; } P.seen = Date.now(); if (b.t === 'B') this._hostBundle(P, b); else if (b.t === 'pi') { try { P.dcR.send(JSON.stringify({ t: 'po', ts: b.ts })); } catch (x) {} } };
        };
        await pc.setRemoteDescription(m.sdp); pc.remoteReady();
        const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
        this.send('c/' + P.id, { t: 'rtc', sdp: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription }, false, P.mq);
      } catch (e) {}
    },
    _hostBundle(P, b) {
      for (const [from, d, fast] of b.l || []) {
        if (from !== P.id || !d) continue;           // a client may only speak for itself
        if (!d.to || d.to === 'p0') ogr.toGame({ from, d });
        this._route(from, d, !!fast);
      }
    },
    _route(from, d, fast) {                        // forward to every other client (or just the addressee)
      if (!this.peers) return;
      for (const Q of this.peers.values()) if (Q.id !== from && Q.info && (!d.to || d.to === Q.id)) qPush(Q.q, from, d, fast);
    },
    _flushHost() {
      if (!this.peers) return;
      for (const P of this.peers.values()) {
        const direct = dcOpen(P), { rel, fast } = qTake(P.q, direct ? P.dcF.bufferedAmount > 128 * 1024 : P.mq && P.mq.backed());
        if (!rel.length && !fast.length) continue;
        if (direct) {
          try { if (rel.length) P.dcR.send(JSON.stringify({ t: 'B', l: rel })); if (fast.length) P.dcF.send(JSON.stringify({ t: 'B', l: fast })); } catch (e) {}
        } else this.send('c/' + P.id, { t: 'B', l: [...rel, ...fast] }, false, P.mq);
      }
    },
    _sweep() {
      if (this.role !== 'host') return;
      const now = Date.now();
      for (const [id, P] of this.peers) if (now - (P.seen || 0) > 15000) this._drop(id, true);
    },
    _drop(id, timedOut) {
      if (!this.peers || !this.peers.has(id)) return;
      const P = this.peers.get(id); this.peers.delete(id); try { P.pc && P.pc.close(); } catch (e) {}
      if (timedOut || this.inMatch) { ogr.toGame({ from: id, d: { t: 'gone' } }); this._route(id, { t: 'gone' }, false); }
      this._lobby();
    },
    _lobby() {
      if (this.role !== 'host') return;
      this.players = [{ id: 'p0', host: true, ...this.profile() }, ...[...this.peers.values()].filter(P => P.info).map(P => P.info)];
      this.sendAll('lobby', { t: 'lobby', code: this.code, players: this.players, inMatch: this.inMatch, build: BUILD, at: Date.now() }, true);
      this.emit('lobby', this.players);
    },
    start() {
      if (this.role !== 'host') return;
      this.players = [{ id: 'p0', host: true, ...this.profile() }, ...[...this.peers.values()].filter(P => P.info).map(P => P.info)];
      const n = this.players.length;
      const info = { seed: (Math.random() * 4294967295) >>> 0, spawn: Math.random() * 5 | 0, busA: Math.random() * 6.283,
        bots: Math.max(5, 20 - n), players: this.players, hostId: 'p0', mid: rnd(6) };
      this.sendAll('a', { t: 'start', from: 'p0', info });
      this.inMatch = true; this._lobby();
      this.emit('start', { ...info, me: 'p0', host: true });
    },
    matchOver() {
      if (this.role === 'host') { this.inMatch = false; this._lobby(); }
      this.toAll({ t: 'gone' });
    },
    updateProfile() {
      if (this.role === 'host') this._lobby();
      else if (this.role === 'client') this.send('h', { t: 'prof', from: this.me, ...this.profile() });
    },

    // ---------------- client ----------------
    async join(code) {
      this.leave(true);
      code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 4) throw new Error('code');
      await iceServers();
      this.role = 'client'; this.code = code; this.me = 'c' + rnd(6);
      const me = this.me, cid = 'ogr' + rnd(10);
      const will = { topic: this.T('a'), msg: JSON.stringify({ t: 'g', from: me, d: { t: 'gone' } }) };
      let lastErr = 'notfound', reachable = false; this._oldSeen = false;
      for (const b of BROKERS) {
        if (this.role !== 'client' || this.me !== me) throw new Error('cancelled');
        let mq;
        try { mq = await mqtt(b, cid, will, (t, s) => this._clientRx(t, s), 6000); } catch (e) { continue; }
        reachable = true; this.mq = mq;
        const res = await new Promise(resolve => {
          let found = false, t2;
          const t1 = setTimeout(() => resolve({ err: 'notfound' }), 3500);
          this._clientWait = (kind, data) => {
            if (kind === 'lobby') { if (!found) { found = true; clearTimeout(t1); mq.sub(this.T('c/' + me)); mq.sub(this.T('a')); setTimeout(() => this.send('h', { t: 'hello', from: me, build: BUILD, ...this.profile() }), 300); t2 = setTimeout(() => resolve({ err: 'timeout' }), 8000); } }
            else if (kind === 'welcome') { clearTimeout(t2); resolve({ ok: data }); }
            else if (kind === 'reject') { clearTimeout(t2); resolve({ err: data }); }
            else if (kind === 'empty') { clearTimeout(t1); resolve({ err: 'notfound' }); }
          };
          mq.sub(this.T('lobby')); mq.sub('ogroyale/v2/' + code + '/lobby');
        });
        this._clientWait = null;
        if (res.ok) {
          mq.onclose = () => { if (this.role === 'client' && this.me === me) { this.emit('closed', 'Lost the connection to the online service. Join again.'); ogr.toGame({ from: 'p0', d: { t: 'gone' } }); this.leave(true); } };
          this.q = mkQueue();
          this._fl = setInterval(() => this._flushClient(), FLUSH_MS);
          this._ping = setInterval(() => this._sendPing(), 2000);
          this._tryDirect();
          return res.ok;
        }
        try { mq.close(); } catch (e) {} this.mq = null;
        lastErr = res.err;
        if (res.err !== 'notfound') break;
      }
      const old = this._oldSeen;
      this.leave(true);
      throw new Error(!reachable ? 'offline' : (lastErr === 'notfound' && old) ? 'oldhost' : lastErr);
    },
    async _tryDirect() {
      try { if (localStorage.getItem('ogrNoDirect')) return; } catch (e) {}
      try {
        const L = this.link = { pc: mkPC(x => this.send('h', { ...x, from: this.me })) };
        L.dcF = L.pc.createDataChannel('f', { ordered: false, maxRetransmits: 0 });
        L.dcR = L.pc.createDataChannel('r');
        const onm = ev => { let b; try { b = JSON.parse(ev.data); } catch (x) { return; } this._clientMsg(b); };
        L.dcF.onmessage = onm; L.dcR.onmessage = onm;
        const off = await L.pc.createOffer(); await L.pc.setLocalDescription(off);
        this.send('h', { t: 'rtc', from: this.me, sdp: L.pc.localDescription.toJSON ? L.pc.localDescription.toJSON() : L.pc.localDescription });
      } catch (e) { this.link = null; }
    },
    _sendPing() {
      const m = { t: 'pi', from: this.me, ts: performance.now() };
      if (dcOpen(this.link)) try { this.link.dcR.send(JSON.stringify(m)); return; } catch (e) {}
      this.send('h', m);
    },
    _clientMsg(m) {
      if (m.t === 'B') { for (const [from, d] of m.l || []) if (from !== this.me && d && (!d.to || d.to === this.me)) ogr.toGame({ from, d }); }
      else if (m.t === 'po') { const r = performance.now() - m.ts; this.rtt = this.rtt == null ? r : this.rtt * .6 + r * .4; ogr.toGame({ from: 'net', d: { t: 'netstat', ...this.stat() } }); }
    },
    _flushClient() {
      if (!this.q) return;
      const direct = dcOpen(this.link), { rel, fast } = qTake(this.q, direct ? this.link.dcF.bufferedAmount > 128 * 1024 : this.mq && this.mq.backed());
      if (!rel.length && !fast.length) return;
      if (direct) { try { if (rel.length) this.link.dcR.send(JSON.stringify({ t: 'B', l: rel })); if (fast.length) this.link.dcF.send(JSON.stringify({ t: 'B', l: fast })); return; } catch (e) {} }
      this.send('h', { t: 'B', from: this.me, l: [...rel, ...fast] });
    },
    _clientRx(t, s) {
      if (/^ogroyale\/v2\//.test(t)) { if (s) this._oldSeen = true; return; }
      if (t === this.T('lobby')) {
        if (!s) { if (this._clientWait) this._clientWait('empty'); else if (this.role === 'client') { this.emit('closed', 'The host closed the lobby.'); ogr.toGame({ from: 'p0', d: { t: 'gone' } }); this.leave(true); } return; }
        let m; try { m = JSON.parse(s); } catch (e) { return; }
        this.players = m.players || []; this.inMatch = !!m.inMatch;
        if (this._clientWait) this._clientWait('lobby');
        this.emit('lobby', this.players);
        return;
      }
      let m; try { m = JSON.parse(s); } catch (e) { return; }
      if (t === this.T('c/' + this.me)) {
        if (m.t === 'welcome') { if (this._clientWait) this._clientWait('welcome', m); }
        else if (m.t === 'reject') { if (this._clientWait) this._clientWait('reject', m.why); }
        else if (m.t === 'rtc') { const L = this.link; if (L) L.pc.setRemoteDescription(m.sdp).then(() => L.pc.remoteReady()).catch(() => {}); }
        else if (m.t === 'ice') { if (this.link && m.c) this.link.pc.addCand(m.c); }
        else this._clientMsg(m);
      } else if (t === this.T('a')) {
        if (m.from === this.me) return;
        if (m.t === 'start') { this.inMatch = true; this.emit('start', { ...m.info, me: this.me, host: false }); }
        else if (m.t === 'g' && m.d && m.d.t === 'gone' && m.from === 'p0') ogr.toGame({ from: 'p0', d: m.d });
      }
    },

    // ---------------- both ----------------
    fromGame(m) {
      if (!m || !m.d || !this.role) return;
      const fast = !!m.f && FAST.has(m.d.t);
      if (this.role === 'host') {
        if (m.d.t === 'gone') { this.sendAll('a', { t: 'g', from: 'p0', d: m.d }); }
        this._route('p0', m.d, fast);
      } else if (this.q) {
        if (m.d.t === 'gone') this.send('a', { t: 'g', from: this.me, d: m.d });
        else qPush(this.q, this.me, m.d, fast);
      }
    },
    toAll(d) { this.fromGame({ d, f: 0 }); },
    leave(silent) {
      const was = this.role;
      clearInterval(this._hb); clearInterval(this._ping); clearInterval(this._fl); clearInterval(this._ns);
      if (this.peers) for (const P of this.peers.values()) try { P.pc && P.pc.close(); } catch (e) {}
      if (this.link) { try { this.link.pc.close(); } catch (e) {} this.link = null; }
      if (this.mq) {
        try {
          if (was === 'host') this.sendAll('lobby', '', true);
          else if (was === 'client' && this.me) this.send('h', { t: 'bye', from: this.me });
        } catch (e) {}
        const all = [...new Set([this.mq, ...(this.mqs || [])])].filter(Boolean); this.mq = null; this.mqs = null;
        all.forEach(q => { q.onclose = null; setTimeout(() => q.close(), 200); });
      }
      this.role = null; this.code = null; this.me = null; this.players = []; this.inMatch = false; this.peers = null; this._clientWait = null; this.q = null; this.rtt = null;
      if (was && !silent) this.emit('left');
    }
  };
  window.NET = Net;
  if (window.ogr && ogr.onFromGame) ogr.onFromGame(m => Net.fromGame(m));
})();
