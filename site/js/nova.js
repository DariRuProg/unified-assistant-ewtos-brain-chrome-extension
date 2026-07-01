/**
 * Weltraum-Hero für das Theme "ewtos Studio Nova".
 * @author Dario | ewtos.com
 *
 * Erzeugt das Tiefen-Sternfeld + Warp-Sterne im Cover, treibt den
 * kontinuierlichen Horizontal-Schwenk (Momentum) und den Button-Warp:
 * Hover friert die Sterne als Lichtstreifen ein, Klick löst den
 * Lichtsprung aus und springt danach in die Analyse.
 * Aktiv nur, wenn das Theme "studio-nova" aktiv ist.
 */
(function () {
  var nova = document.getElementById('nova');
  if (!nova) return;

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var cover = document.getElementById('cover');
  var glowHost = document.getElementById('novaGlow');
  var warpHost = document.getElementById('novaWarp');
  var btn = document.getElementById('novaBtn');
  var far = nova.querySelector('.nova-far');
  var mid = nova.querySelector('.nova-mid');
  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var isNova = function () { return document.documentElement.dataset.theme === 'studio-nova'; };

  /* ---- große, leuchtende Sterne ---- */
  var frag = document.createDocumentFragment();
  for (var i = 0; i < 16; i++) {
    var s = document.createElement('div');
    s.className = 'nova-star tw';
    var size = rand(1.8, 3.6);
    s.style.width = s.style.height = size.toFixed(1) + 'px';
    s.style.left = rand(0, 100).toFixed(2) + '%';
    s.style.top = rand(0, 92).toFixed(2) + '%';
    var t = Math.random();
    s.style.background = t > 0.86 ? '#fbbf24' : (t > 0.74 ? '#cbb6ff' : '#ffffff');
    s.style.boxShadow = '0 0 ' + (size * 2.4).toFixed(0) + 'px ' + (t > 0.86 ? 'rgba(251,191,36,0.9)' : 'rgba(255,255,255,0.85)');
    s.style.setProperty('--dur', rand(2.5, 5).toFixed(1) + 's');
    s.style.setProperty('--del', rand(0, 5).toFixed(1) + 's');
    s.style.setProperty('--lo', rand(0.45, 0.7).toFixed(2));
    s.style.setProperty('--hi', rand(0.85, 1).toFixed(2));
    frag.appendChild(s);
  }
  glowHost.appendChild(frag);

  /* ---- Warp-Sterne (Punkte → Lichtstreifen) ---- */
  for (var j = 0; j < 130; j++) {
    var x = rand(0, 100), y = rand(0, 100);
    var ang = Math.atan2(y - 50, x - 50) * 180 / Math.PI;
    var r = Math.hypot(x - 50, y - 50);
    var len = (26 + r * 3.1).toFixed(0);
    var w = document.createElement('div');
    w.className = 'nova-warpstar';
    w.style.left = x.toFixed(2) + '%';
    w.style.top = y.toFixed(2) + '%';
    w.style.setProperty('--ang', ang.toFixed(1) + 'deg');
    w.style.setProperty('--len', len + 'px');
    w.style.transform = 'rotate(' + ang.toFixed(1) + 'deg)';
    warpHost.appendChild(w);
  }

  /* ---- Kontinuierlicher Schwenk mit Momentum (nur horizontal) ---- */
  var vel = 0, panX = 0;
  var SENS = 0.07, FRICTION = 0.95, MAXV = 3;
  if (!reduce) {
    cover.addEventListener('mousemove', function (e) {
      if (!isNova()) return;
      vel -= e.movementX * SENS;   // Maus links → Raum nach rechts
      if (vel > MAXV) vel = MAXV; else if (vel < -MAXV) vel = -MAXV;
    });
    (function frame() {
      if (isNova()) {
        panX += vel;
        vel *= FRICTION;
        far.style.backgroundPositionX = (panX * 0.22) + 'px';
        mid.style.backgroundPositionX = (panX * 0.42) + 'px';
        glowHost.style.transform = 'translateX(' + Math.max(-50, Math.min(50, panX * 0.04)) + 'px)';
      }
      requestAnimationFrame(frame);
    })();
  }

  /* ---- Button: Hover = einfrieren, Klick = Lichtsprung → Analyse ---- */
  var jumping = false;
  function goToTarget() {
    var href = btn.getAttribute('data-href');
    if (!href) return;
    if (href.charAt(0) === '#') {
      var target = document.querySelector(href);
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    } else {
      window.location.href = href;
    }
  }
  btn.addEventListener('mouseenter', function () {
    if (reduce || jumping) return;
    nova.classList.add('warping');
  });
  btn.addEventListener('mouseleave', function () {
    if (jumping) return;
    nova.classList.remove('warping');
  });
  btn.addEventListener('click', function () {
    if (reduce) { goToTarget(); return; }
    if (jumping) return;
    jumping = true;
    nova.classList.remove('warping');
    nova.classList.add('jump');
    setTimeout(function () {
      nova.classList.remove('jump');
      jumping = false;
      goToTarget();
      if (btn.matches(':hover')) nova.classList.add('warping');
    }, 620);
  });
})();
