// OG Royale online: runs after the game script (only does anything in an online match).
// Model: the host's game runs the bots, storm and battle bus; every player is in charge of
// their own movement, shots, builds and loot pickups and tells everyone else. Remote players
// are added to the game's own `bots` list, so hit detection, the kill feed, players-left,
// spectating and Victory Royale all keep working without changes to the game itself.
(function(){
'use strict';
const M = window.MPX;
if (!M || !M.on) return;
const I = M.info, N = window.OGRNET, ME = I.me, HOST = !!I.host;
M.host = HOST;
const PL = {}; (I.players || []).forEach(p => PL[p.id] = p);
const pname = id => (PL[id] && PL[id].name) || 'Player';
const HUM = {};           // player id -> entry in bots[]
const BST = [];           // client: latest host state for each bot index
let APPLY = 0;            // >0 while applying a remote event (never re-broadcast those)
let SEQ = 0;
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
const send = (d, fast) => { try { N.send({ d, f: fast ? 1 : 0 }); } catch (e) {} };
const V3 = a => new THREE.Vector3(a[0], a[1], a[2]);
const apply = fn => { APPLY++; try { fn(); } finally { APPLY--; } };

// ---------- world check: everyone must have generated the same island ----------
const hashWorld = () => {
  let h = 2166136261 >>> 0;
  const add = v => { h ^= (Math.round(v * 10) | 0); h = Math.imul(h, 16777619) >>> 0; };
  trees.forEach(q => { add(q.x); add(q.z); });
  LT.forEach(l => { add(l.x); add(l.z); add(l.chest ? 1 : 0); });
  add(cols.length); add(cx0); add(cz0);
  return h.toString(36);
};
LT.forEach((l, i) => l.id = 'w' + i);
const MYHASH = hashWorld();
M.hash = MYHASH;

// ---------- wrap game functions so local actions are shared ----------
const d0 = drop, rl0 = rmLoot, tr0 = tracer, ph0 = pieceHit, pl0 = place, ce0 = confirmEdit,
      th0 = treeHit, e0 = end, k0 = kill, bk0 = botKill, sh0 = shoot;

window.drop = function (x, z, it, chest, y) {
  d0(x, z, it, chest, y);
  const l = LT[LT.length - 1];
  if (APPLY || !M.started) return;
  l.id = ME + '.' + (SEQ++);
  send({ t: 'drop', id: l.id, x: r2(x), z: r2(z), y: y == null ? null : r2(y), it: it || null, c: chest ? 1 : 0 });
};
window.rmLoot = function (l) {
  rl0(l);
  if (!APPLY && M.started && l && l.id) send({ t: 'take', id: l.id });
};
let TRQ = [];
window.shoot = function () {
  const it = INV[sel - 1]; M.sk = it && it.k;
  try { return sh0.apply(this, arguments); } finally { M.sk = null; }
};
window.tracer = function (a, b) {
  tr0(a, b);
  if (!APPLY && M.started) TRQ.push([r2(a.x), r2(a.y), r2(a.z), r2(b.x), r2(b.y), r2(b.z), M.sk || 0]);
};
window.pieceHit = function (p, d, pt) {
  ph0(p, d, pt);
  if (APPLY || !M.started || !p || p.k == null) return;
  send({ t: 'ph', k: p.k, d: Math.round(d), p: pt ? [r2(pt.x), r2(pt.y), r2(pt.z)] : null });
  if (p.hp <= 0) send({ t: 'pkill', k: p.k });
};
window.place = function () {
  const n = PCS.length; pl0();
  if (PCS.length > n) { const p = PCS[PCS.length - 1]; send({ t: 'pc', k: p.k, ty: p.type, b: p.b, r: p.r, ax: p.ax }); }
};
window.confirmEdit = function () {
  const p = ED && ED.p; ce0();
  if (p) send({ t: 'pe', k: p.k, g: p.grid.slice() });
};
window.treeHit = function (q) {
  th0(q);
  send({ t: 'tree', i: trees.indexOf(q), hp: q.hp });
};
window.end = function (src, place) {
  const by = src ? (src.net ? src.net : { b: bots.indexOf(src) }) : null;
  e0(src, place);
  send({ t: 'pdead', by, place });
  INV.forEach((it, i) => { if (i > 0 && it) drop(P.x + R(-1.5, 1.5), P.z + R(-1.5, 1.5), it); });
};
window.kill = function (b) {                       // host shot one of its own bots
  k0(b);
  if (HOST && !b.net) send({ t: 'bdead', i: bots.indexOf(b), by: ME });
};
const hu0 = hud2;
window.hud2 = function () { hu0(); const c = $('cmode'); if (c && c.textContent !== 'ONLINE') c.textContent = 'ONLINE'; };
window.botKill = function (v, k) {                 // bot vs bot (host only)
  bk0(v, k);
  send({ t: 'bdead', i: bots.indexOf(v), by: { b: bots.indexOf(k) } });
};

// ---------- hooks the game script calls (see patches in game.html) ----------
M.feedAll = s => { feed(s); if (HOST) send({ t: 'feed', s }); };
M.warmDone = () => {
  if (HOST) { send({ t: 'bus' }); return true; }
  return PHt >= WARM + 4;                           // fallback if the host's signal was missed
};
M.busA = I.busA || 0;
M.bhh = (ob, b) => send({ t: 'bhh', to: ob.net, d: Math.round(b.dm * R(.8, 1.3) * 10) / 10, b: bots.indexOf(b) });
M.shotHit = (h, dmg) => {
  const b = h.object.userData.bot;
  if (!b) return false;
  if (!b.net && HOST) return false;                 // host hitting its own bot: normal game code
  if (b.dead) return true;
  const hd = h.object.userData.head, dd = PH == 'play' ? dmg * (hd ? 2 : 1) : 0;
  if (!dd) { burst(h.point, 0x9a9a9a, 2); return true; }
  sfx(hd ? 'head' : 'hit'); P.sc = (P.sc || 0) + Math.round(dd); b.hit = 1; b.hb = performance.now();
  hitmark(); dmgNum(h.point, b, dd, hd, false); burst(h.point, hd ? 0xffe600 : 0xff3b3b, 4); mkBar(b);
  if (b.net) send({ t: 'hit', to: b.net, d: Math.round(dd * 10) / 10, hd: hd ? 1 : 0 });
  else { b.hp = Math.max(1, b.hp - dd); send({ t: 'bhit', to: I.hostId, i: bots.indexOf(b), d: Math.round(dd * 10) / 10 }); }
  return true;
};
let leaveArmed = false;
M.leave = () => {
  const others = Object.values(HUM).some(b => !b.dead && !b.gone);
  if (HOST && others && !leaveArmed) {
    leaveArmed = true; setTimeout(() => leaveArmed = false, 5000);
    toast("You're the host. Leaving now freezes the match for your friends. Press again to leave anyway.");
    return;
  }
  window.close();
};

// ---------- remote players as puppets ----------
function mkTag(nm) {
  const c = CV(256, 64, (g, w) => { g.font = 'italic 900 30px system-ui'; g.textAlign = 'center'; const tw = g.measureText(nm).width + 30; g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect((w - tw) / 2, 10, tw, 44); g.fillStyle = '#ffe600'; g.fillText(nm, w / 2, 43); });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX(c), transparent: true }));
  s.scale.set(2.2, .55, 1); s.renderOrder = 998; s.visible = false; scene.add(s); return s;
}
function addHuman(p) {
  const o = person((p.skin | 0) % SK.length);
  try { setBB(o, p.bb | 0); } catch (e) {}
  const b = { net: p.id, nm: p.name || 'Player', o, x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, ry: 0, hp: 100, dead: false, cd: 9, wx: 0, wz: 0, wt: 0, dm: 0, nt: 1, k: 0, sc: 0, snap: 1 };
  [o.b, o.l, o.h].forEach(m => m.userData.bot = b); o.h.userData.head = 1;
  o.g.visible = false; scene.add(o.g); b.tag = mkTag(b.nm);
  bots.push(b); HUM[p.id] = b; return b;
}
function gunSync(b, g) {
  if (b.gk === g) return; b.gk = g;
  if (b.gun) { if (b.gun.parent) b.gun.parent.remove(b.gun); b.gun = null; }
  if (!g || g == 'b') return;
  try {
    if (g == 'px') b.gun = pickM(b.o.aR, (b.st && b.st.px) | 0);
    else { const [k, r] = g.split('.'); if (WD[k]) b.gun = gunMesh(b.o.aR, k, r | 0); }
  } catch (e) { b.gun = null; }
}
function carSync(b, s) {
  if (!s.dv) return false;
  if (!b.car || b.carK !== (s.ck | 0)) { if (b.car) scene.remove(b.car); try { b.car = mkCar(s.ck | 0); b.carK = s.ck | 0; scene.add(b.car); } catch (e) { b.car = null; return false; } }
  const c = b.car, k = .35;
  if (c.userData.x == null) { c.userData.x = s.cx; c.userData.y = s.cy; c.userData.z = s.cz; c.userData.h = s.ch; }
  const u = c.userData; u.x += (s.cx - u.x) * k; u.y += (s.cy - u.y) * k; u.z += (s.cz - u.z) * k;
  let dh = s.ch - u.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); u.h += dh * k;
  c.position.set(u.x, u.y, u.z); c.rotation.y = u.h; c.visible = true;
  const o = b.o, ox = -.4, oz = .15; rj(o);
  o.g.position.set(u.x + ox * Math.cos(u.h) + oz * Math.sin(u.h), u.y + (c.seatY || .9) - .92 + .2, u.z - ox * Math.sin(u.h) + oz * Math.cos(u.h)); o.g.rotation.y = u.h;
  try { aim2(o.lL, o.lL.kn, [-.05, -.2, 1], [0, -1, .25]); aim2(o.lR, o.lR.kn, [.05, -.2, 1], [0, -1, .25]); [o.lL, o.lR].forEach(j => j.ft.quaternion.copy(j.quaternion).multiply(j.kn.quaternion).invert()); aim2(o.aL, o.aL.el, [-.15, -.75, .6], [.15, -.1, 1]); aim2(o.aR, o.aR.el, [.15, -.75, .6], [-.15, -.1, 1]); } catch (e) {}
  if (b.gun) b.gun.visible = false;
  return true;
}
function pupHuman(b, dt) {
  const s = b.st, o = b.o;
  if (!s || b.dead) { o.g.visible = false; if (b.tag) b.tag.visible = false; return true; }
  const k = 1 - Math.exp(-dt * 11);
  if (b.snap || Math.hypot(s.x - b.qx, s.z - b.qz) > 30 || Math.abs(s.y - b.qy) > 30) { b.qx = s.x; b.qy = s.y; b.qz = s.z; b.ry = s.ry; b.snap = 0; }
  else { b.qx += (s.x - b.qx) * k; b.qy += (s.y - b.qy) * k; b.qz += (s.z - b.qz) * k; let dr = s.ry - b.ry; dr = Math.atan2(Math.sin(dr), Math.cos(dr)); b.ry += dr * k; }
  b.x = b.qx; b.y = b.qy; b.z = b.qz; b.hp = s.hp; b.sc = s.sc || 0;
  b.nt = (s.m != 3 || s.d) ? 1 : 0; b.bus = s.m == 0; b.fall = null;
  const vis = s.m != 0;
  o.g.visible = vis;
  if (!vis) { if (b.tag) b.tag.visible = false; return true; }
  gunSync(b, s.g);
  if (!carSync(b, s)) {
    o.g.position.set(b.x, b.y, b.z); o.g.rotation.y = b.ry;
    if (s.e >= 0 && s.m == 3) {
      if (b.gun) b.gun.visible = false;
      pose(o, T, s.e); o.g.position.y += b.y; if (s.e == 3) o.g.rotation.y += T * 4;
    } else {
      if (b.gun) b.gun.visible = true;
      const md = s.m == 2 ? 'glide' : s.m == 1 ? 'sky' : s.j ? 'jump' : 'g';
      rj(o); anim(o, T, s.sp || 0, md);
      if (md == 'g' || md == 'jump') {
        if (s.g && s.g != 'px' && s.g != 'b') { o.aR.rotation.set(-1.45, 0, .05); o.aR.el.rotation.x = 0; o.aL.rotation.set(-1.2, 0, -.4); o.aL.el.rotation.x = -.55; }
        else if (s.g == 'px' && b.gun) { try { pxHold(o, b.gun, s.px | 0, T); } catch (e) {} }
      } else if (b.gun && s.g == 'px') { try { pxFree(o, b.gun); } catch (e) {} }
    }
    if (s.m == 2 && !b.gl) { b.gl = mkGlider((s.gl | 0) % GL.length); o.g.add(b.gl); }
    if (b.gl) b.gl.visible = s.m == 2;
  }
  if (b.tag) { const dd = Math.hypot(b.x - P.x, b.z - P.z); b.tag.visible = dd < 70 || dead; b.tag.position.set(b.x, b.y + 2.75, b.z); }
  barTick(b);
  return true;
}
function botDie(b) {
  if (b.dead) return;
  b.dead = true; scene.remove(b.o.g); if (b.bar) scene.remove(b.bar); if (b.tag) b.tag.visible = false;
  try { bPlace(b); } catch (e) {} b.td = T;
}
function pupBot(b, dt) {
  const i = bots.indexOf(b), s = BST[i];
  if (!s) return true;
  if (s[7]) { botDie(b); return true; }
  const o = b.o;
  if (s[5] == 0) { o.g.visible = false; b.bus = true; return true; }
  b.bus = false; b.fall = null; o.g.visible = true;
  const tx = s[1] / 10, ty = s[2] / 10, tz = s[3] / 10, try_ = s[4] / 100, k = 1 - Math.exp(-dt * 7);
  if (b.snap == null || Math.hypot(tx - b.qx, tz - b.qz) > 30 || Math.abs(ty - b.qy) > 30) { b.qx = tx; b.qy = ty; b.qz = tz; b.ry = try_; b.snap = 0; }
  else { b.qx += (tx - b.qx) * k; b.qy += (ty - b.qy) * k; b.qz += (tz - b.qz) * k; let dr = try_ - b.ry; dr = Math.atan2(Math.sin(dr), Math.cos(dr)); b.ry += dr * k; }
  const mv = Math.hypot(b.qx - (b.lpx || b.qx), b.qz - (b.lpz || b.qz)) / Math.max(dt, 1e-3); b.lpx = b.qx; b.lpz = b.qz;
  b.x = b.qx; b.y = b.qy; b.z = b.qz;
  o.g.position.set(b.x, b.y, b.z); o.g.rotation.y = b.ry;
  if (s[5] == 1 || s[5] == 2) {
    if (!b.gl) { b.gl = mkGlider(i % GL.length); o.g.add(b.gl); }
    b.gl.visible = s[5] == 2; anim(o, T + b.x, 0, s[5] == 1 ? 'sky' : 'glide');
  } else {
    if (b.gl) b.gl.visible = false;
    anim(o, T + b.x, mv > .6 ? .8 : 0);
    o.aR.rotation.set(-1.45, 0, .05); o.aR.el.rotation.x = 0; o.aL.rotation.set(-1.2, 0, -.4); o.aL.el.rotation.x = -.55;
  }
  if (s[6] < b.hp - .5) { b.hb = performance.now(); mkBar(b); }
  b.hp = s[6];
  barTick(b);
  return true;
}
M.pup = (b, dt) => b.net ? pupHuman(b, dt) : (!HOST ? pupBot(b, dt) : false);

// ---------- what we send ----------
function myState() {
  const drv = !!(DRV && CAR), pos = (P.mode == 'bus' || !pl || !pl.g) ? P : pl.g.position, it = INV[sel - 1];
  let g = '';
  if (build) g = 'b'; else if (it && !(cons > 0)) { if (it.t == 'w') g = it.k + '.' + (it.r || 0); else if (it.k == 'px') g = 'px'; }
  const mv = P.mode == 'ground' && (K.KeyW || K.KeyA || K.KeyS || K.KeyD);
  const s = { t: 's', x: r2(pos.x), y: r2(drv ? P.y : pos.y), z: r2(pos.z), ry: r3(drv ? CAR.h : yaw),
    m: P.mode == 'bus' ? 0 : P.mode == 'air' ? 1 : P.mode == 'glide' ? 2 : 3,
    sp: mv ? (K.ShiftLeft ? 1 : .72) : 0, j: (!P.grounded && P.vy > 1.5 || P.vy < -4) ? 1 : 0,
    e: emoNow, g, hp: Math.max(0, Math.round(P.hp)), sc: Math.round(P.sc || 0), d: dead ? 1 : 0,
    gl: S.gl | 0, px: S.px | 0 };
  if (drv) { s.dv = 1; s.cx = r2(CAR.x); s.cy = r2(CAR.y); s.cz = r2(CAR.z); s.ch = r3(CAR.h); s.ck = CAR.k | 0; }
  return s;
}
function botStates() {
  const out = [];
  for (let i = 0; i < S.bots && i < bots.length; i++) {
    const b = bots[i];
    if (b.net) continue;
    let md = 3;
    if (b.dead || b.bus || !b.o.g.visible) md = 0;
    else if (b.fall) md = (b.y - gh(b.x, b.z, b.y) > 55) ? 1 : 2;
    out.push([i, Math.round((b.x || 0) * 10), Math.round((b.y || 0) * 10), Math.round((b.z || 0) * 10), Math.round(b.o.g.rotation.y * 100), md, Math.max(0, Math.round(b.hp)), b.dead ? 1 : 0]);
  }
  return out;
}
let tick = 0;
setInterval(() => {
  if (!M.started) return;
  tick++;
  // ~12 updates/s for players, ~6/s for bots: smooth with interpolation, light on the relay
  if (tick % 2 == 0 && TRQ.length) { send({ t: 'trc', l: TRQ.splice(0, 40) }, true); if (TRQ.length > 120) TRQ = []; }
  if (tick % 2 == 0) send(myState(), true);
  if (HOST && tick % 4 == 0) send({ t: 'bs', a: botStates() }, true);
  if (HOST && tick % 50 == 0 && STO < 1e8) send({ t: 'clk', e: Math.round((T - STO) * 100) / 100 });
}, 40);

// ---------- what we receive ----------
function credit(vnm) { S.elim++; P.sc = (P.sc || 0) + 100; S.vb += 50; save(); sfx('elim'); feed(S.name + ' eliminated ' + vnm); feed('+50 V-Bucks'); }
function killerName(by) {
  if (by === ME) return S.name;
  if (typeof by == 'string') return pname(by);
  if (by && by.b != null && bots[by.b]) return bots[by.b].nm || 'A player';
  return null;
}
function gone(id) {
  const b = HUM[id];
  if (b && !b.dead) { botDie(b); b.gone = true; feed(b.nm + ' left the match'); }
  else if (b) b.gone = true;
  if (id === I.hostId && !HOST && !M.hostGone) { M.hostGone = true; toast('The host left the match. Bots are frozen.'); }
}
const H = {
  s(from, d) { const b = HUM[from]; if (b) { b.st = d; if (d.d && !b.dead) b.pd = 1; } },
  bs(from, d) { if (HOST) return; d.a.forEach(r => BST[r[0]] = r); },
  trc(from, d) {
    let near = null;
    apply(() => d.l.forEach(q => { tr0(V3(q), new THREE.Vector3(q[3], q[4], q[5])); if (q[6]) { const dd = Math.hypot(q[0] - P.x, q[2] - P.z); if (dd < 70 && (!near || dd < near.d)) near = { d: dd, k: q[6] }; } }));
    if (near) sfx('shot', near.k);
  },
  hit(from, d) { if (!dead && !won) hurt(d.d, HUM[from] || null); },
  bhh(from, d) { if (!dead && !won) hurt(d.d, bots[d.b] || null); },
  bhit(from, d) {
    if (!HOST) return;
    const b = bots[d.i]; if (!b || b.dead || b.net) return;
    b.hp -= d.d; b.hb = performance.now(); b.hit = 1; mkBar(b);
    if (b.hp <= 0) {
      const K2 = HUM[from]; if (K2) K2.k = (K2.k || 0) + 1;
      botDie(b); feed(pname(from) + ' eliminated ' + (b.nm || 'a player'));
      const w = ['ar', 'smg', 'sg', 'pi'][d.i % 4];
      drop(b.x, b.z, { t: 'w', k: w, r: Math.random() < .2 ? 2 : Math.random() < .5 ? 1 : 0, mag: WD[w].m });
      drop(b.x + 1, b.z, { t: 'a', a: WD[w].am, n: WD[w].am == 's' ? 6 : 30 });
      send({ t: 'bdead', i: d.i, by: from });
    }
  },
  bdead(from, d) {
    const b = bots[d.i]; if (!b) return;
    const was = b.dead; botDie(b);
    if (was && d.by !== ME) return;
    if (d.by === ME) { credit(b.nm || 'a player'); return; }
    const kn = killerName(d.by); if (kn) feed(kn + ' eliminated ' + (b.nm || 'a player'));
  },
  pdead(from, d) {
    const b = HUM[from]; if (!b || b.dead) return;
    botDie(b);
    if (d.by === ME) { credit(b.nm); return; }
    if (d.by && d.by.b != null && bots[d.by.b] && HOST) bots[d.by.b].k = (bots[d.by.b].k || 0) + 1;
    const kn = killerName(d.by);
    feed(kn ? kn + ' eliminated ' + b.nm : b.nm + ' was eliminated');
  },
  feed(from, d) { feed(d.s); },
  bus(from, d) { if (!HOST && (PH == 'load' || PH == 'warm')) { if (PH == 'load') { PH = 'warm'; } startBus(); } },
  clk(from, d) { if (!HOST && STO < 1e8 && (PH == 'bus' || PH == 'play')) STO = T - d.e; },
  drop(from, d) { apply(() => { d0(d.x, d.z, d.it, d.c ? 1 : 0, d.y == null ? undefined : d.y); LT[LT.length - 1].id = d.id; }); },
  take(from, d) { const l = LT.find(x => x.id === d.id); if (l) apply(() => rl0(l)); },
  pc(from, d) {
    if (placed.has(d.k)) return; placed.add(d.k);
    const p = { type: d.ty, b: d.b, r: d.r, ax: d.ax, grid: Array(9).fill(0), cols: [], k: d.k }; p.pop = 0;
    p.mx = BMX[p.type] || 150; p.hp = Math.round(p.mx * .1); p.bt = 0; p.done = 0; const ax = p.type == 'x' ? 'x' : 'y'; p.ax2 = ax;
    p.clip = new THREE.Plane(ax == 'x' ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, -1, 0), ax == 'x' ? p.b[0] : p.b[1]);
    p.mat = PFILL.clone(); p.mat.clippingPlanes = [p.clip]; PCS.push(p); mkPiece(p); popApply(p);
    if (Math.hypot(p.b[0] - P.x, p.b[2] - P.z) < 40) sfx('build');
  },
  ph(from, d) { const p = PCS.find(q => q.k === d.k); if (p) apply(() => ph0(p, d.d, d.p ? V3(d.p) : null)); },
  pkill(from, d) { const p = PCS.find(q => q.k === d.k); if (p) pieceKill(p); },
  pe(from, d) {
    const p = PCS.find(q => q.k === d.k); if (!p) return;
    if (ED && ED.p === p) closeEdit();
    p.grid = d.g; if (p.grid.every(v => v)) { placed.delete(p.k); const i = PCS.indexOf(p); if (i >= 0) PCS.splice(i, 1); }
    mkPiece(p);
  },
  tree(from, d) {
    const q = trees[d.i]; if (!q || !q.g.visible) return;
    if (q.mx == null) q.mx = Math.round(300 * q.g.scale.y / 50) * 50 || 300;
    q.hp = d.hp; q.shk = 1;
    if (d.hp <= 0) { q.g.visible = false; if (q.wp) q.wp.visible = false; [q.t, q.l].forEach(m => { const i = solidM.indexOf(m); if (i >= 0) solidM.splice(i, 1); }); burst(new THREE.Vector3(q.x, 2, q.z), 0xc98a4a, 8); }
  },
  hash(from, d) {
    if (from === I.hostId && d.h !== MYHASH) { M.mismatch = d.h; console.warn('world mismatch', d.h, MYHASH); toast("Your island didn't load the same as the host's. Try restarting the match."); }
  },
  left(from, d) { gone(d.id); },
  gone(from) { gone(from); }
};
M.HUM = HUM; M.BST = BST; M.rx = [];
N.on(m => {
  const d = m && m.d; if (!d || !H[d.t]) return;
  if (d.t != 's' && d.t != 'bs' && d.t != 'trc') { M.rx.push(m.from + ':' + d.t); if (M.rx.length > 100) M.rx.shift(); }
  if (d.to && d.to !== ME) return;
  if (m.from === ME) return;
  try { H[d.t](m.from, d); } catch (e) { console.warn('net', d.t, e); }
});

// ---------- start the match straight away (no lobby screen) ----------
function begin() {
  if (!S.prevMode) { S.prevMode = S.mode; S.prevBots = S.bots; }
  S.mode = 'Solo'; S.bots = Math.max(1, Math.min(29, I.bots | 0)); S.cupPlay = '';
  const el = ren.domElement, rpl = el.requestPointerLock;
  el.requestPointerLock = function () { return Promise.resolve(); };
  try { startGame(); } finally { el.requestPointerLock = rpl; }
  (I.players || []).forEach(p => { if (p.id !== ME) addHuman(p); });
  M.started = true;
  send({ t: 'hash', h: MYHASH });
  setTimeout(() => toast('Online match · ' + (I.players || []).length + ' players · click to aim'), 1200);
}
requestAnimationFrame(() => setTimeout(begin, 50));
})();
