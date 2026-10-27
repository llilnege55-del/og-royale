// OG Royale lobby networking (runs in the launcher window, which stays open between matches).
// All lobby and match traffic goes through a free public MQTT relay over secure WebSockets, so it
// works on almost any network (no direct PC-to-PC connection needed). Several relays are tried in
// order; the host announces its lobby on the first one it reaches and joiners look on each in turn.
(function () {
  const CFG = (window.ogr && ogr.cfg) || {};
  const BROKERS = /^wss?:\/\/127\.0\.0\.1/.test(CFG.signal || '') ? [{ url: CFG.signal }] : [
    { url: 'wss://broker.emqx.io:8084/mqtt' },
    { url: 'wss://broker.hivemq.com:8884/mqtt' },
    { url: 'wss://public.cloud.shiftr.io', user: 'public', pass: 'public' },
    { url: 'wss://test.mosquitto.org:8081' }
  ];
  const ROOT = 'ogroyale/v2/';
  const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rnd = n => Array.from({ length: n }, () => ALPH[Math.random() * ALPH.length | 0]).join('');
  const MAX = 8, BUILD = (CFG.build | 0);
  const enc = new TextEncoder(), dec = new TextDecoder();

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

  const Net = {
    role: null, code: null, me: null, players: [], ev: {}, inMatch: false,
    on(k, f) { this.ev[k] = f; },
    emit(k, ...a) { const f = this.ev[k]; if (f) try { f(...a); } catch (e) { console.error(e); } },
    profile: () => ({}),
    T(x) { return ROOT + this.code + '/' + x; },
    send(topic, m, retain) { if (this.mq) this.mq.pub(this.T(topic), JSON.stringify(m), retain); },

    // ---------------- host ----------------
    async host() {
      this.leave(true);
      this.role = 'host'; this.me = 'p0'; this.peers = new Map(); this.inMatch = false;
      const cid = 'ogr' + rnd(10);
      let code = rnd(4), seen = {};
      // will: if the host's connection drops, the broker clears the lobby so joiners know it closed
      const willFor = c => ({ topic: ROOT + c + '/lobby', msg: '', retain: true });
      this.code = code;
      this.mq = await anyBroker(cid, willFor(code), (t, s) => this._hostRx(t, s));
      this.mq.onclose = () => { if (this.role === 'host') { this.emit('closed', 'Lost the connection to the online service. Create the lobby again.'); this.leave(true); } };
      this.mq.sub(this.T('h')); this.mq.sub(this.T('a'));
      this.players = [{ id: 'p0', host: true, ...this.profile() }];
      this._lobby();
      this._hb = setInterval(() => this._sweep(), 3000);
      return this.code;
    },
    _hostRx(t, s) {
      if (!this.code || !s) return;
      let m; try { m = JSON.parse(s); } catch (e) { return; }
      const from = m.from; if (!from || from === 'p0') return;
      if (t === this.T('h')) {
        let P = this.peers.get(from);
        if (m.t === 'hello') {
          if ((m.build | 0) !== BUILD) { this.send('c/' + from, { t: 'reject', why: (m.build | 0) < BUILD ? 'oldyou' : 'oldhost' }); return; }
          if (this.inMatch) { this.send('c/' + from, { t: 'reject', why: 'match' }); return; }
          if (!P && this.peers.size >= MAX - 1) { this.send('c/' + from, { t: 'reject', why: 'full' }); return; }
          P = P || { id: from }; P.seen = Date.now();
          P.info = { id: from, name: String(m.name || 'Player').slice(0, 24), skin: m.skin | 0, bb: m.bb | 0, gl: m.gl | 0, lvl: m.lvl | 0 };
          this.peers.set(from, P);
          this.send('c/' + from, { t: 'welcome', you: from, code: this.code });
          this._lobby();
        } else if (P) {
          P.seen = Date.now();
          if (m.t === 'prof') { Object.assign(P.info, { name: String(m.name || 'Player').slice(0, 24), skin: m.skin | 0, bb: m.bb | 0, gl: m.gl | 0, lvl: m.lvl | 0 }); this._lobby(); }
          else if (m.t === 'bye') this._drop(from);
        }
      } else if (t === this.T('a') && m.t === 'g') {
        const P = this.peers.get(from); if (P) P.seen = Date.now();
        if (m.d && m.d.t === 'gone' && P && !this.inMatch) { this._drop(from); return; }
        if (!m.d.to || m.d.to === 'p0') ogr.toGame({ from, d: m.d });
      }
    },
    _sweep() {
      if (this.role !== 'host') return;
      const now = Date.now();
      for (const [id, P] of this.peers) if (now - (P.seen || 0) > 15000) this._drop(id, true);
    },
    _drop(id, timedOut) {
      if (!this.peers || !this.peers.has(id)) return;
      this.peers.delete(id);
      if (timedOut) { ogr.toGame({ from: id, d: { t: 'gone' } }); this.send('a', { t: 'g', from: id, d: { t: 'gone' } }); }
      this._lobby();
    },
    _lobby() {
      if (this.role !== 'host') return;
      this.players = [{ id: 'p0', host: true, ...this.profile() }, ...[...this.peers.values()].filter(P => P.info).map(P => P.info)];
      this.send('lobby', { t: 'lobby', code: this.code, players: this.players, inMatch: this.inMatch, build: BUILD, at: Date.now() }, true);
      this.emit('lobby', this.players);
    },
    start() {
      if (this.role !== 'host') return;
      this.players = [{ id: 'p0', host: true, ...this.profile() }, ...[...this.peers.values()].filter(P => P.info).map(P => P.info)];
      const n = this.players.length;
      const info = { seed: (Math.random() * 4294967295) >>> 0, spawn: Math.random() * 5 | 0, busA: Math.random() * 6.283,
        bots: Math.max(5, 20 - n), players: this.players, hostId: 'p0', mid: rnd(6) };
      this.send('a', { t: 'start', from: 'p0', info });
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
      this.role = 'client'; this.code = code; this.me = 'c' + rnd(6);
      const me = this.me, cid = 'ogr' + rnd(10);
      const will = { topic: this.T('a'), msg: JSON.stringify({ t: 'g', from: me, d: { t: 'gone' } }) };
      let lastErr = 'notfound', reachable = false;
      for (const b of BROKERS) {
        if (this.role !== 'client' || this.me !== me) throw new Error('cancelled');
        let mq;
        try { mq = await mqtt(b, cid, will, (t, s) => this._clientRx(t, s), 6000); } catch (e) { continue; }
        reachable = true; this.mq = mq;
        const res = await new Promise(resolve => {
          let found = false;
          this._clientWait = (kind, data) => {
            if (kind === 'lobby') { if (!found) { found = true; mq.sub(this.T('c/' + me)); mq.sub(this.T('a')); setTimeout(() => this.send('h', { t: 'hello', from: me, build: BUILD, ...this.profile() }), 300); clearTimeout(t1); t2 = setTimeout(() => resolve({ err: 'timeout' }), 8000); } }
            else if (kind === 'welcome') resolve({ ok: data });
            else if (kind === 'reject') resolve({ err: data });
            else if (kind === 'empty') resolve({ err: 'notfound' });
          };
          let t2; const t1 = setTimeout(() => resolve({ err: 'notfound' }), 3500);
          mq.sub(this.T('lobby'));
        });
        this._clientWait = null;
        if (res.ok) {
          mq.onclose = () => { if (this.role === 'client' && this.me === me) { this.emit('closed', 'Lost the connection to the online service. Join again.'); ogr.toGame({ from: 'p0', d: { t: 'gone' } }); this.leave(true); } };
          this._ping = setInterval(() => this.send('h', { t: 'ping', from: me }), 4000);
          return res.ok;
        }
        try { mq.close(); } catch (e) {} this.mq = null;
        lastErr = res.err;
        if (res.err !== 'notfound') break;      // found the lobby but it refused us: no point trying other relays
      }
      this.leave(true);
      throw new Error(reachable ? lastErr : 'offline');
    },
    _clientRx(t, s) {
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
      } else if (t === this.T('a')) {
        if (m.from === this.me) return;
        if (m.t === 'start') { this.inMatch = true; this.emit('start', { ...m.info, me: this.me, host: false }); }
        else if (m.t === 'g' && m.d && (!m.d.to || m.d.to === this.me)) ogr.toGame({ from: m.from, d: m.d });
      }
    },

    // ---------------- both ----------------
    fromGame(m) {
      if (!m || !m.d || !this.mq || !this.role) return;
      this.send('a', { t: 'g', from: this.me, d: m.d });
    },
    toAll(d) { this.fromGame({ d, f: 0 }); },
    leave(silent) {
      const was = this.role;
      clearInterval(this._hb); clearInterval(this._ping);
      if (this.mq) {
        try {
          if (was === 'host') this.send('lobby', '', true);
          else if (was === 'client' && this.me) { this.send('h', { t: 'bye', from: this.me }); }
        } catch (e) {}
        const mq = this.mq; this.mq = null; mq.onclose = null; setTimeout(() => mq.close(), 200);
      }
      this.role = null; this.code = null; this.me = null; this.players = []; this.inMatch = false; this.peers = null; this._clientWait = null;
      if (was && !silent) this.emit('left');
    }
  };
  // publishing an empty retained message must go out as an empty payload, not '""'
  const _send = Net.send;
  Net.send = function (topic, m, retain) { if (m === '') { if (this.mq) this.mq.pub(this.T(topic), '', retain); return; } return _send.call(this, topic, m, retain); };
  window.NET = Net;
  if (window.ogr && ogr.onFromGame) ogr.onFromGame(m => Net.fromGame(m));
})();
