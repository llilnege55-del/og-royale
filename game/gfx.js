// OG Royale graphics settings + FPS counter (set in the launcher: Settings > Graphics quality / Show FPS).
// Auto: starts on High and steps down if a match keeps running below ~45 FPS.
(function () {
  if (typeof ren === 'undefined') return;
  let cfg = {}; try { cfg = JSON.parse(localStorage.getItem('ogrLauncher')) || {}; } catch (e) {}
  const LEVELS = ['low', 'medium', 'high'];
  const choice = LEVELS.includes(cfg.gfx) ? cfg.gfx : 'auto';
  let level = choice === 'auto' ? (LEVELS.includes(cfg.gfxAuto) ? cfg.gfxAuto : 'high') : choice;
  const dpr = devicePixelRatio || 1;
  function apply(l) {
    level = l;
    const pr = l === 'high' ? Math.min(dpr, 1.5) : l === 'medium' ? Math.min(dpr, 1) : Math.min(dpr, 1) * .75;
    ren.setPixelRatio(pr); ren.setSize(innerWidth, innerHeight);
    try {
      sun.castShadow = l !== 'low';
      const ms = l === 'high' ? 2048 : 1024;
      if (sun.shadow.mapSize.x !== ms) { sun.shadow.mapSize.set(ms, ms); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
      ren.shadowMap.type = l === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap; ren.shadowMap.needsUpdate = true;
    } catch (e) {}
    cam.far = l === 'high' ? 4000 : l === 'medium' ? 900 : 520; cam.updateProjectionMatrix();
  }
  apply(level);
  // FPS counter
  let el = null;
  if (cfg.fps) { el = document.createElement('div'); el.style.cssText = 'position:fixed;right:8px;bottom:4px;z-index:40;font:700 11px system-ui,sans-serif;color:#7dff9a;background:rgba(0,0,0,.45);padding:2px 7px;border-radius:5px;pointer-events:none'; document.body.appendChild(el); }
  let frames = 0, t0 = performance.now(), slow = 0;
  function tick(now) {
    requestAnimationFrame(tick); frames++;
    const dt = now - t0; if (dt < 1000) return;
    const fps = frames * 1000 / dt; frames = 0; t0 = now;
    if (el) { el.textContent = Math.round(fps) + ' FPS · ' + level.toUpperCase(); el.style.color = fps >= 50 ? '#7dff9a' : fps >= 30 ? '#ffe600' : '#ff6b6b'; }
    // Auto: only judge during a match, when the window is visible
    if (choice !== 'auto' || typeof inLobby === 'undefined' || inLobby || document.hidden || (typeof paused !== 'undefined' && paused)) { slow = 0; return; }
    slow = fps < 45 ? slow + 1 : 0;
    if (slow >= 4 && level !== 'low') {
      slow = 0; const nl = LEVELS[LEVELS.indexOf(level) - 1]; apply(nl);
      try { cfg.gfxAuto = nl; localStorage.setItem('ogrLauncher', JSON.stringify(cfg)); } catch (e) {}
      try { toast('Graphics lowered to ' + nl.toUpperCase() + ' to keep the game smooth'); } catch (e) {}
    }
  }
  requestAnimationFrame(tick);
  window.OGR_GFX = { get level() { return level; }, apply };
})();
