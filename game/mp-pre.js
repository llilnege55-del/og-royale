// OG Royale online: runs before the game script.
// In an online match every player's island, loot and storm centre must be identical,
// so world generation uses a random seed shared by the host. Solo play is untouched.
(function(){
  var r0 = Math.random;
  window.__R0 = function(){ return r0(); };   // three.js object IDs use this, so they never shift the seeded sequence
  var N = window.OGRNET, info = null;
  try { info = N && N.info ? N.info() : null; } catch (e) { info = null; }
  var M = {
    on: !!info, info: info, busA: 0, started: false,
    unseed: function(){ Math.random = r0; },
    warmDone: function(){ return true; },
    feedAll: function(s){ feed(s); },
    pup: function(){ return false; },
    shotHit: function(){ return false; },
    bhh: function(){},
    leave: function(){ location.reload(); }
  };
  if (M.on) {
    var s = (info.seed >>> 0) || 1;
    Math.random = function(){
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  window.MPX = M;
  window.RLD = function(){ if (M.on) M.leave(); else location.reload(); };
})();
