/* =====================================================================
   Study Atlas — 3D d20 for Lucky Roll, with rarity effects
   A real 20-sided die with a glossy gem finish. The rarer the roll,
   the bigger the show:

     common     clean toss, small dust ring and a few sparks
     rare       harder landing, double shockwave, spark burst, light flash
     epic       charges up in the air, energy pulled in, slams down,
                screen shake, light rays, triple shockwave
     legendary  long charge with the screen dimming, slow-motion teeter
                on the edge of the wrong face, zoom-in, huge slam,
                turns to polished gold, rays, floating embers
     mythic     everything goes dark, rainbow charge, teeter, giant slam,
                white-out flash, six shockwaves, a second aftershock,
                pearly rainbow die, rainbow rays and embers

   Everything moves smoothly: colours blend instead of switching, the
   number fades in, the die is tossed up instead of jumping, and the
   effects of the last roll fade out when the next one starts.

   Three.js is only downloaded the first time the die is shown.

   USE
     const die = await D20.mount(dieElement, {
       style: "one",          // your look: blank faces, one big number in front
       stage: overlayElement, // optional: full-screen effects layer (rays, shockwaves, flash, shake)
       scale: 2.8             // only without stage: how much your CSS scales the die box up
     });
     die.spin(true)                         fast spin while you wait
     await die.roll(n, colour)              resolves on impact; effects keep playing after
     await die.roll(n, colour, { tier: "mythic" })   force a tier (otherwise worked out from n)
     die.setColor(c, ms)   die.clearFx()   die.show(n)   die.idle()   die.dispose()
     await D20.snapshot(20, "#b9aeff", 116, "one")   still picture for the corner button
   If WebGL or the download fails, mount() rejects: keep your SVG die as the fallback.
   ===================================================================== */
window.D20 = (function () {
  const api = { THREE_URL: "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js" };
  let T = null, loading = null;
  const load = () => loading || (loading = import(api.THREE_URL).then(m => (T = m)));

  /* ---------- rarity tiers: every number here makes it bigger ---------- */
  const TIERS = {
    common:    { charge: 0,    teeter: 0, shake: 0,    rings: 1, sparks: 18,  rays: 0, flash: 0,    zoom: 0,    embers: 0,   blackout: 0,    glow: 0.15 },
    rare:      { charge: 0,    teeter: 0, shake: 0.35, rings: 2, sparks: 55,  rays: 0, flash: 0.22, zoom: 0,    embers: 0,   blackout: 0,    glow: 0.3 },
    epic:      { charge: 1000, teeter: 0, shake: 0.7,  rings: 3, sparks: 120, rays: 1, flash: 0.45, zoom: 0.12, embers: 25,  blackout: 0.35, glow: 0.55 },
    legendary: { charge: 1400, teeter: 1, shake: 1.1,  rings: 4, sparks: 200, rays: 1, flash: 0.75, zoom: 0.28, embers: 60,  blackout: 0.6,  glow: 0.7, gold: 1 },
    mythic:    { charge: 2000, teeter: 1, shake: 1.6,  rings: 6, sparks: 320, rays: 2, flash: 1,    zoom: 0.38, embers: 120, blackout: 0.88, glow: 0.8, rainbow: 1 }
  };
  api.tiers = TIERS;
  api.tierOf = n => n === 20 ? "mythic" : n === 19 ? "legendary" : n >= 17 ? "epic" : n >= 12 ? "rare" : "common";

  /* ---------- helpers ---------- */
  function mix(hex, to, f) {
    const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
    const ch = (x, s) => (x >> s) & 255;
    const m = s => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * f);
    return "#" + ((1 << 24) | (m(16) << 16) | (m(8) << 8) | m(0)).toString(16).slice(1);
  }
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const easeIn = t => t * t;
  const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const approach = (cur, target, rate, dt) => cur + (target - cur) * Math.min(1, rate * dt);

  function canvasTex(sizePx, draw) {
    const c = document.createElement("canvas"); c.width = c.height = sizePx;
    draw(c.getContext("2d"), sizePx);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  }
  const softDot = s => canvasTex(s, (x, n) => {
    const g = x.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.35, "rgba(255,255,255,.55)"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, n, n);
  });
  const raysTex = () => canvasTex(512, (x, n) => {
    const c = n / 2, N = 18;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = a0 + (Math.PI * 2 / N) * 0.42;
      const g = x.createRadialGradient(c, c, 0, c, c, c);
      g.addColorStop(0, "rgba(255,255,255,.9)"); g.addColorStop(0.5, "rgba(255,255,255,.25)"); g.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = g; x.beginPath(); x.moveTo(c, c); x.arc(c, c, c, a0, a1); x.closePath(); x.fill();
    }
  });

  /* ---------- the face sheet ----------
     Painted as data, not colours:  red = light-to-dark shading of each face,
     green = the number, blue = the number's outline. The shader below adds the
     colour, so colour changes and the number fading in are perfectly smooth. */
  const CELL = 256, COLS = 5, ROWS = 4;
  const TRI = { ax: 0.5, ay: 0.08, lx: 0.04, ly: 0.877, rx: 0.96, ry: 0.877 };
  function paintAtlas(canvas, only) {             // only: undefined = all numbers, null = none, n = just n
    const c = canvas.getContext("2d");
    c.fillStyle = "#000"; c.fillRect(0, 0, canvas.width, canvas.height);
    for (let n = 1; n <= 20; n++) {
      const i = n - 1, ox = (i % COLS) * CELL, oy = Math.floor(i / COLS) * CELL;
      const ax = ox + TRI.ax * CELL, ay = oy + TRI.ay * CELL;
      const lx = ox + TRI.lx * CELL, ly = oy + TRI.ly * CELL;
      const rx = ox + TRI.rx * CELL, ry = oy + TRI.ry * CELL;
      const g = c.createLinearGradient(ax, ay, ax, ly);
      g.addColorStop(0, "rgb(255,0,0)"); g.addColorStop(1, "rgb(0,0,0)");
      c.fillStyle = g;
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(lx, ly); c.lineTo(rx, ry); c.closePath(); c.fill();
      c.strokeStyle = "rgba(255,0,0,.35)"; c.lineWidth = 6; c.stroke();            // soft bevel
      if (only !== undefined && only !== n) continue;
      const one = only !== undefined;
      const cx = (ax + lx + rx) / 3, cy = (ay + ly + ry) / 3 + 4;
      c.font = "800 " + (one ? (n >= 10 ? 92 : 104) : (n >= 10 ? 74 : 86)) + "px system-ui, -apple-system, Segoe UI, sans-serif";
      c.textAlign = "center"; c.textBaseline = "middle";
      c.lineWidth = 10; c.strokeStyle = "rgb(110,0,255)"; c.strokeText(String(n), cx, cy);
      c.fillStyle = "rgb(110,255,0)"; c.fillText(String(n), cx, cy);
      if (!one && (n === 6 || n === 9)) c.fillRect(cx - 18, cy + 40, 36, 7);
    }
  }

  function buildDie(label) {
    const geo = new T.IcosahedronGeometry(1, 0);
    const pos = geo.attributes.position, faces = [];
    for (let f = 0; f < 20; f++) {
      const a = new T.Vector3().fromBufferAttribute(pos, f * 3);
      const b = new T.Vector3().fromBufferAttribute(pos, f * 3 + 1);
      const c = new T.Vector3().fromBufferAttribute(pos, f * 3 + 2);
      const centre = a.clone().add(b).add(c).divideScalar(3);
      faces.push({ normal: centre.clone().normalize(), up: a.clone().sub(centre).normalize(), n: 0 });
    }
    const order = [1, 7, 3, 9, 5, 10, 4, 8, 2, 6];          // opposite faces add up to 21
    let k = 0;
    faces.forEach((fc, i) => {
      if (fc.n) return;
      const opp = faces.find((o, j) => j !== i && !o.n && o.normal.dot(fc.normal) < -0.99);
      fc.n = order[k]; opp.n = 21 - order[k]; k++;
    });
    const W = CELL * COLS, H = CELL * ROWS, uv = new Float32Array(120);
    faces.forEach((fc, f) => {
      const i = fc.n - 1, ox = (i % COLS) * CELL, oy = Math.floor(i / COLS) * CELL;
      const p = (x, y) => [(ox + x * CELL) / W, 1 - (oy + y * CELL) / H];
      uv.set([...p(TRI.ax, TRI.ay), ...p(TRI.lx, TRI.ly), ...p(TRI.rx, TRI.ry)], f * 6);
    });
    geo.setAttribute("uv", new T.BufferAttribute(uv, 2));
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    paintAtlas(canvas, label);
    const tex = new T.CanvasTexture(canvas); tex.colorSpace = T.NoColorSpace; tex.anisotropy = 8;

    const U = { light: { value: new T.Color() }, dark: { value: new T.Color() }, num: { value: 1 } };
    const mat = new T.MeshPhysicalMaterial({
      map: tex, roughness: 0.28, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.08,
      emissive: new T.Color(0xffffff), emissiveIntensity: 0, iridescence: 0, iridescenceIOR: 1.7
    });
    mat.onBeforeCompile = sh => {
      sh.uniforms.uLight = U.light; sh.uniforms.uDark = U.dark; sh.uniforms.uNum = U.num;
      sh.fragmentShader = "uniform vec3 uLight;\nuniform vec3 uDark;\nuniform float uNum;\n" +
        sh.fragmentShader.replace("#include <map_fragment>", `
          #ifdef USE_MAP
            vec4 dieTex = texture2D( map, vMapUv );
            vec3 face = mix( uDark, uLight, dieTex.r );
            face = mix( face, uDark * 0.25, dieTex.b * uNum );
            diffuseColor.rgb = mix( face, vec3( 1.0 ), dieTex.g * uNum );
          #endif`);
    };
    const mesh = new T.Mesh(geo, mat);
    const edges = new T.LineSegments(new T.EdgesGeometry(geo), new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28 }));
    edges.scale.setScalar(1.002); mesh.add(edges);
    return { mesh, mat, tex, canvas, faces, U };
  }

  function studio(renderer) {
    const env = new T.Scene();
    env.add(new T.Mesh(new T.SphereGeometry(10, 32, 16), new T.MeshBasicMaterial({ color: 0x1a1f2b, side: T.BackSide })));
    const panel = (c, x, y, z, w, h) => {
      const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: c, side: T.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
    };
    panel(0xffffff, 0, 7, 3, 8, 3); panel(0xc9c0ff, -7, 2, 2, 3, 6);
    panel(0x8fc4f5, 7, 0, 2, 3, 6); panel(0xf3a3c0, 0, -4, 6, 6, 1.5);
    const pm = new T.PMREMGenerator(renderer);
    const tex = pm.fromScene(env, 0.03).texture; pm.dispose();
    return tex;
  }

  function faceQuat(faces, n, view) {
    const fc = faces.find(f => f.n === n);
    const q1 = new T.Quaternion().setFromUnitVectors(fc.normal, view);
    const up1 = fc.up.clone().applyQuaternion(q1);
    const want = new T.Vector3(0, 1, 0).sub(view.clone().multiplyScalar(view.y)).normalize();
    const ang = Math.atan2(view.dot(up1.clone().cross(want)), up1.dot(want));
    return new T.Quaternion().setFromAxisAngle(view, ang).multiply(q1);
  }

  /* =================================================================== */
  api.mount = async function (el, opts) {
    opts = opts || {};
    await load();
    const stage = opts.stage || null;
    const bleed = stage ? 1 : (opts.bleed || 1.8);
    const pxr = Math.min(window.devicePixelRatio || 1, 2) * (stage ? 1 : (opts.scale || 1));

    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance", preserveDrawingBuffer: !!opts.preserve });
    renderer.setPixelRatio(pxr);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const cv = renderer.domElement;
    const host = stage || el;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    cv.style.cssText = stage
      ? "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:block;z-index:" + (opts.zIndex || 5)
      : "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none;display:block";
    host.appendChild(cv);

    const scene = new T.Scene();
    scene.environment = studio(renderer);
    const FOV = 30;
    const camera = new T.PerspectiveCamera(FOV, 1, 0.1, 400);
    const camDir = new T.Vector3(0, 0.9, 5.2).normalize();
    const DIST = stage ? 14 : Math.hypot(0.9, 5.2) * bleed;
    const baseCamPos = camDir.clone().multiplyScalar(DIST);
    camera.position.copy(baseCamPos); camera.lookAt(0, 0, 0);
    const anchorCam = camera.clone();
    scene.add(camera);
    const view = camDir.clone();

    const key = new T.DirectionalLight(0xffffff, 1.6); key.position.set(-2, 4, 3); scene.add(key);
    scene.add(new T.AmbientLight(0xffffff, 0.25));

    const root = new T.Group(); scene.add(root);
    const body = new T.Group(); root.add(body);
    const oneNumber = opts.style === "one";
    let label = oneNumber ? 20 : undefined;
    const die = buildDie(label);
    body.add(die.mesh);
    const glow = new T.PointLight(0xffffff, 0, 8); glow.position.set(0, 0, 2.2); root.add(glow);

    const shadow = new T.Mesh(new T.PlaneGeometry(2.4, 2.4), new T.MeshBasicMaterial({
      map: canvasTex(128, (x, n) => { const g = x.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2); g.addColorStop(0, "rgba(0,0,0,.55)"); g.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g; x.fillRect(0, 0, n, n); }),
      transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = -1.08; root.add(shadow);

    /* --- smooth colour --- */
    let color = opts.color || "#b9aeff";
    const cur = { light: new T.Color(mix(color, "#ffffff", 0.35)), dark: new T.Color(mix(color, "#000000", 0.35)), em: new T.Color(color) };
    let colAnim = null;
    const emO = new T.Color(), emTmp = new T.Color();
    let emoK = 0;                                            // blend towards a special glow colour (rainbow)
    function applyColor() { die.U.light.value.copy(cur.light); die.U.dark.value.copy(cur.dark); }
    function applyEm() { emTmp.copy(cur.em).lerp(emO, emoK); die.mat.emissive.copy(emTmp); glow.color.copy(emTmp); }
    applyColor();
    function setColor(c, ms) {
      color = c;
      const to = { light: new T.Color(mix(c, "#ffffff", 0.35)), dark: new T.Color(mix(c, "#000000", 0.35)), em: new T.Color(c) };
      if (!ms) { colAnim = null; cur.light.copy(to.light); cur.dark.copy(to.dark); cur.em.copy(to.em); applyColor(); return; }
      colAnim = { t: 0, d: ms / 1000, from: { light: cur.light.clone(), dark: cur.dark.clone(), em: cur.em.clone() }, to };
    }
    function stepColor(dt) {
      if (!colAnim) return;
      colAnim.t += dt;
      const k = easeInOut(Math.min(1, colAnim.t / colAnim.d));
      ["light", "dark", "em"].forEach(p => cur[p].copy(colAnim.from[p]).lerp(colAnim.to[p], k));
      applyColor();
      if (k >= 1) colAnim = null;
    }

    /* --- smooth number: fade out, swap, fade in --- */
    let numTarget = 1;
    function setLabel(n, instant) {
      if (!oneNumber) return;
      if (n == null) { numTarget = 0; if (instant) die.U.num.value = 0; return; }
      if (label !== n) { label = n; paintAtlas(die.canvas, n); die.tex.needsUpdate = true; die.U.num.value = 0; }
      numTarget = 1; if (instant) die.U.num.value = 1;
    }

    /* --- effects layer --- */
    const fx = new T.Group(); root.add(fx);
    const DOT = softDot(64);
    const aura = new T.Sprite(new T.SpriteMaterial({ map: DOT, color: 0xffffff, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
    aura.position.copy(view).multiplyScalar(-0.8); aura.scale.setScalar(3); fx.add(aura);
    const rays = new T.Sprite(new T.SpriteMaterial({ map: raysTex(), color: 0xffffff, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
    rays.position.copy(view).multiplyScalar(-1.2); fx.add(rays);
    const rays2 = rays.clone(); rays2.material = rays.material.clone(); fx.add(rays2);

    const MAXP = 900;
    const pGeo = new T.BufferGeometry();
    const pPos = new Float32Array(MAXP * 3), pCol = new Float32Array(MAXP * 3);
    pGeo.setAttribute("position", new T.BufferAttribute(pPos, 3));
    pGeo.setAttribute("color", new T.BufferAttribute(pCol, 3));
    const pMat = new T.PointsMaterial({ size: 0.13, map: DOT, vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    const points = new T.Points(pGeo, pMat); points.frustumCulled = false; fx.add(points);
    const P = Array.from({ length: MAXP }, () => ({ on: false }));
    let pNext = 0;
    const tmpC = new T.Color();
    function emit(o) {
      const p = P[pNext]; pNext = (pNext + 1) % MAXP;
      Object.assign(p, { on: true, x: o.x || 0, y: o.y || 0, z: o.z || 0, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0,
        life: 0, max: o.life || 1, g: o.g == null ? -5 : o.g, drag: o.drag == null ? 1.2 : o.drag,
        r: o.c.r, gg: o.c.g, b: o.c.b, hue: o.hue == null ? null : o.hue, fadeIn: o.fadeIn || 0 });
    }
    function burst(count, c, o) {
      o = o || {};
      for (let i = 0; i < count; i++) {
        const th = Math.random() * Math.PI * 2, ph = Math.acos(rand(-0.2, 1));
        const sp = rand(o.min || 2, o.max || 6);
        const dir = new T.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
        const col = o.rainbow ? new T.Color().setHSL(Math.random(), 1, 0.6) : (Math.random() < 0.3 ? new T.Color(0xffffff) : c.clone());
        emit({ x: dir.x * 0.6, y: dir.y * 0.6 - 0.3, z: dir.z * 0.6, vx: dir.x * sp, vy: dir.y * sp, vz: dir.z * sp,
          life: rand(0.6, o.life || 1.4), g: o.g == null ? -6 : o.g, drag: 1.4, c: col, hue: o.rainbow ? Math.random() : null });
      }
    }
    function implode(c, rainbow) {
      const th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI, R = rand(3, 5.5);
      const d = new T.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
      const life = rand(0.45, 0.8);
      const col = rainbow ? new T.Color().setHSL(Math.random(), 1, 0.65) : (Math.random() < 0.35 ? new T.Color(0xffffff) : c.clone());
      emit({ x: d.x * R, y: d.y * R, z: d.z * R, vx: -d.x * R / life, vy: -d.y * R / life, vz: -d.z * R / life, life, g: 0, drag: 0, c: col, fadeIn: 0.15 });
    }
    function ember(c, rainbow) {
      const col = rainbow ? new T.Color().setHSL(Math.random(), 1, 0.65) : c.clone().lerp(new T.Color(0xffffff), Math.random() * 0.4);
      emit({ x: rand(-2.2, 2.2), y: rand(-1.1, -0.6), z: rand(-1.5, 1), vx: rand(-0.2, 0.2), vy: rand(0.8, 1.8), vz: 0,
        life: rand(1.6, 3), g: 0.15, drag: 0.2, c: col, hue: rainbow ? Math.random() : null, fadeIn: 0.3 });
    }
    function stepParticles(dt) {
      for (let i = 0; i < MAXP; i++) {
        const p = P[i];
        if (!p.on) { pCol[i * 3] = pCol[i * 3 + 1] = pCol[i * 3 + 2] = 0; continue; }
        p.life += dt;
        if (p.life >= p.max) { p.on = false; continue; }
        const k = Math.exp(-p.drag * dt);
        p.vx *= k; p.vy = p.vy * k + p.g * dt; p.vz *= k;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.y < -1.05 && p.vy < 0 && p.g < 0) { p.y = -1.05; p.vy *= -0.35; p.vx *= 0.7; p.vz *= 0.7; }
        const fade = (1 - p.life / p.max) * (p.fadeIn ? Math.min(1, p.life / p.fadeIn) : 1);
        if (p.hue != null) { tmpC.setHSL((p.hue + p.life * 0.6) % 1, 1, 0.6); p.r = tmpC.r; p.gg = tmpC.g; p.b = tmpC.b; }
        pPos[i * 3] = p.x; pPos[i * 3 + 1] = p.y; pPos[i * 3 + 2] = p.z;
        pCol[i * 3] = p.r * fade; pCol[i * 3 + 1] = p.gg * fade; pCol[i * 3 + 2] = p.b * fade;
      }
      pGeo.attributes.position.needsUpdate = true; pGeo.attributes.color.needsUpdate = true;
    }

    const RING_GEO = new T.RingGeometry(0.72, 1, 96);
    const rings = [];
    function ring(c, maxR, dur, delay, rainbow, alpha) {
      const m = new T.Mesh(RING_GEO, new T.MeshBasicMaterial({ color: c, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.position.y = -1.06; m.scale.setScalar(0.6); fx.add(m);
      rings.push({ m, t: -delay, dur, maxR, rainbow, alpha: alpha || 0.9 });
    }
    function stepRings(dt, now) {
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i]; r.t += dt;
        if (r.t < 0) continue;
        const k = r.t / r.dur;
        if (k >= 1) { fx.remove(r.m); r.m.material.dispose(); rings.splice(i, 1); continue; }
        r.m.scale.setScalar(0.6 + easeOut(k) * r.maxR);
        r.m.material.opacity = Math.min(1, k * 12) * (1 - k) * r.alpha;      // quick fade in, slow fade out
        if (r.rainbow) r.m.material.color.setHSL((now / 900 + i * 0.15) % 1, 1, 0.6);
      }
    }

    const dimmer = new T.Mesh(new T.PlaneGeometry(4000, 4000), new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: true, depthWrite: false }));
    dimmer.position.z = -DIST * 6; dimmer.renderOrder = -10; camera.add(dimmer);
    const flash = new T.Mesh(new T.PlaneGeometry(50, 50), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false, depthWrite: false, blending: T.AdditiveBlending }));
    flash.position.z = -1; flash.renderOrder = 999; camera.add(flash);

    /* --- time, tweens, per-frame updaters --- */
    let timeScale = 1, shake = 0, zoom = 0, state = "idle", raf = 0, last = performance.now(), alive = true;
    let tweens = [], updaters = [];
    const tween = (ms, fn) => new Promise(res => tweens.push({ t: 0, d: ms / 1000, fn, res }));
    const spinAxis = new T.Vector3(0.4, 1, 0.25).normalize(), tmpQ = new T.Quaternion();
    let spinSpeed = 0.5, spinTarget = 0.5, bob = 0, bobTarget = 0, height = 0, squash = 0, spinManual = false;

    body.quaternion.copy(faceQuat(die.faces, 20, view));

    const ndc = new T.Vector2(), ray = new T.Raycaster(), plane = new T.Plane(new T.Vector3(0, 0, 1), 0), hit = new T.Vector3();
    let lastW = 0, lastH = 0, s = 1;
    function layout() {
      if (!stage) {
        const size = opts.size || el.clientWidth || 160;
        const W = size * bleed;
        if (W !== lastW) { renderer.setSize(W, W, false); cv.style.width = cv.style.height = W + "px"; camera.aspect = 1; lastW = W; }
        root.position.set(0, 0, 0); s = 1;
      } else {
        const sr = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
        if (sr.width !== lastW || sr.height !== lastH) {
          renderer.setSize(sr.width, sr.height, false);
          camera.aspect = anchorCam.aspect = sr.width / Math.max(1, sr.height);
          anchorCam.updateProjectionMatrix(); anchorCam.updateMatrixWorld(true);
          lastW = sr.width; lastH = sr.height;
        }
        ndc.set(((r.left + r.width / 2 - sr.left) / sr.width) * 2 - 1, -((r.top + r.height / 2 - sr.top) / sr.height) * 2 + 1);
        ray.setFromCamera(ndc, anchorCam);
        if (ray.ray.intersectPlane(plane, hit)) root.position.copy(hit);
        const pxPerUnit = sr.height / (2 * DIST * Math.tan((FOV * Math.PI / 180) / 2));
        s = Math.max(0.05, (r.width / 2.787) / pxPerUnit);
      }
      root.scale.setScalar(s);
      pMat.size = 0.13 * s;
    }

    function frame(now) {
      if (!alive) return;
      raf = requestAnimationFrame(frame);
      if (stage && getComputedStyle(stage).visibility === "hidden") { last = now; return; }   // overlay hidden: skip drawing
      const real = Math.min(0.05, (now - last) / 1000); last = now;
      const dt = real * timeScale;
      layout();
      const list = tweens;
      for (let i = list.length - 1; i >= 0; i--) {
        const tw = list[i]; tw.t += dt;
        const k = Math.min(1, tw.t / tw.d); tw.fn(k, dt);
        if (k >= 1) { list.splice(i, 1); tw.res(); }
      }
      for (let i = updaters.length - 1; i >= 0; i--) if (updaters[i](dt, now) === false) updaters.splice(i, 1);
      stepColor(real); applyEm();
      die.U.num.value = approach(die.U.num.value, numTarget, numTarget ? 9 : 8, real);
      // free spin (idle / waiting / charging) with smooth speed changes
      if (state === "idle" || state === "spin" || state === "charge") {
        if (!spinManual) spinSpeed = approach(spinSpeed, spinTarget, 4, real);
        body.quaternion.premultiply(tmpQ.setFromAxisAngle(spinAxis, dt * spinSpeed));
        bob = approach(bob, bobTarget, 5, real);
        if (state !== "charge") height = bob * Math.sin(now / 110);
      }
      body.position.y = height;
      body.scale.set(1 + squash * 0.75, 1 - squash, 1 + squash * 0.75);
      shadow.scale.setScalar(1 - Math.min(0.5, Math.max(0, height) * 0.35));
      shadow.material.opacity = 1 - Math.min(0.7, Math.max(0, height) * 0.45);
      stepParticles(dt); stepRings(dt, now);
      shake *= Math.exp(-real * 5);
      camera.position.copy(baseCamPos);
      if (shake > 0.002) camera.position.add(new T.Vector3(rand(-1, 1), rand(-1, 1), 0).multiplyScalar(shake * DIST * 0.012));
      camera.fov = FOV * (1 - zoom);
      camera.updateProjectionMatrix();
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);

    /* --- ending the last roll's show: everything fades instead of snapping --- */
    function clearFx(instant, forRoll) {
      // forRoll: the new roll takes over glow, aura, dimming and zoom itself, smoothly from where they are
      tweens = []; updaters = []; timeScale = 1; spinManual = false;
      const m = die.mat;
      const from = { r1: rays.material.opacity, r2: rays2.material.opacity, au: aura.material.opacity, dim: dimmer.material.opacity,
        fl: flash.material.opacity, met: m.metalness, rough: m.roughness, em: m.emissiveIntensity, ir: m.iridescence, zoom, squash, glow: glow.intensity, emo: emoK };
      const apply = e => {
        rays.material.opacity = from.r1 * (1 - e); rays2.material.opacity = from.r2 * (1 - e);
        flash.material.opacity = from.fl * (1 - e);
        m.metalness = from.met + (0.05 - from.met) * e; m.roughness = from.rough + (0.28 - from.rough) * e;
        if (from.ir) m.iridescence = Math.max(0.001, from.ir * (1 - e));
        if (forRoll) return;
        emoK = from.emo * (1 - e);
        aura.material.opacity = from.au * (1 - e); dimmer.material.opacity = from.dim * (1 - e);
        m.emissiveIntensity = from.em * (1 - e); glow.intensity = from.glow * (1 - e);
        zoom = from.zoom * (1 - e); squash = from.squash * (1 - e);
      };
      if (instant) {
        apply(1); m.iridescence = 0; shake = 0;
        P.forEach(p => (p.on = false));
        rings.forEach(r => { fx.remove(r.m); r.m.material.dispose(); }); rings.length = 0;
        return;
      }
      tween(600, k => apply(easeInOut(k))).then(() => { if (m.iridescence <= 0.002) m.iridescence = 0; });
      // sparks, embers and shockwaves already in the air finish on their own
    }

    /* =========================== THE ROLL =========================== */
    async function roll(n, c, o) {
      o = o || {};
      clearFx(false, true);
      const st = { em: die.mat.emissiveIntensity, au: aura.material.opacity, dim: dimmer.material.opacity, gl: glow.intensity, z: zoom, emo: emoK };
      const tier = o.tier || api.tierOf(n), X = TIERS[tier];
      const rc = c || color;
      const col = new T.Color(rc);
      const target = faceQuat(die.faces, n, view);
      setLabel(null);

      /* 1. CHARGE (epic and up) */
      if (X.charge) {
        state = "charge"; spinManual = true;
        setColor(rc, X.charge * 0.8);                       // the die slowly takes on its rarity colour
        const sp0 = spinSpeed, h0 = height, dim0 = dimmer.material.opacity;
        let pullAcc = 0;
        const pull = dt => { pullAcc += (60 + X.sparks * 0.9) * dt; while (pullAcc > 1) { implode(col, X.rainbow); pullAcc--; } };
        updaters.push(pull);
        const rbC = new T.Color();
        await tween(X.charge, k => {
          height = h0 + (0.15 + 0.9 - h0) * easeOut(k) + Math.sin(k * 40) * 0.02 * k;
          spinSpeed = sp0 + (38 - sp0) * easeIn(k);
          die.mat.emissiveIntensity = st.em + (1 - st.em) * k;
          aura.material.opacity = st.au + (1 - st.au) * k;
          aura.scale.setScalar(2.4 + Math.sin(k * 30) * 0.15 + k * 1.2);
          aura.material.color.copy(X.rainbow ? rbC.setHSL((k * 2) % 1, 1, 0.6) : col);
          if (X.rainbow) { emO.setHSL((k * 3) % 1, 1, 0.55); emoK = st.emo + (1 - st.emo) * Math.min(1, k * 4); }
          else emoK = st.emo * (1 - k);
          dimmer.material.opacity = dim0 + (X.blackout - dim0) * easeOut(k);
          zoom = st.z + (X.zoom * 0.4 - st.z) * easeOut(k);
          shake = Math.max(shake, X.shake * 0.25 * k);
          glow.intensity = st.gl + (10 - st.gl) * k;
        });
        updaters.splice(updaters.indexOf(pull), 1);
        burst(X.sparks * 0.3, col, { min: 1, max: 3, g: 0, life: 0.6, rainbow: X.rainbow });
      }

      /* 2. TUMBLE: tossed up (if it wasn't charging), then three bounces onto the face */
      state = "anim"; spinManual = false;
      const tilt = X.teeter ? 0.62 : 0;
      const tAxis = new T.Vector3(Math.cos(rand(0, 6.28)), 0, Math.sin(rand(0, 6.28))).normalize();
      const endQ = tilt ? new T.Quaternion().setFromAxisAngle(tAxis, tilt).multiply(target) : target;
      const startQ = body.quaternion.clone(), axis = new T.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
      const turns = Math.PI * 2 * (2.5 + Math.random()) * (X.charge ? 1.4 : 1);
      const h0 = height, toss = X.charge ? 0 : 0.2, H = X.charge ? Math.max(0.6, h0) : 1.1;
      const em0 = die.mat.emissiveIntensity, au0 = aura.material.opacity;
      const path = new T.Quaternion();
      let tinted = !!X.charge;
      await tween(X.charge ? 1300 : 1900, k => {
        path.setFromAxisAngle(axis, turns * (1 - easeOut(k))).multiply(endQ);
        body.quaternion.copy(startQ).slerp(path, easeInOut(Math.min(1, k / 0.25)));
        if (k < toss) height = h0 + (H - h0) * Math.sin((k / toss) * Math.PI / 2);         // smooth toss up
        else { const t = (k - toss) / (1 - toss); height = H * Math.abs(Math.cos(Math.PI * 2.5 * t)) * Math.pow(1 - t, 2.2); }
        const hitK = Math.max(0, 1 - height * 6) * (1 - k);
        squash = k > toss ? hitK * 0.08 : 0;
        if (!tinted && k > 0.45) { tinted = true; setColor(rc, 650); }           // colour blends in as it lands
        if (X.charge) {
          die.mat.emissiveIntensity = em0 + (0.1 - em0) * k; aura.material.opacity = au0 * (1 - k);
          if (X.rainbow) emoK = 1 - easeOut(Math.min(1, k / 0.35));
        } else {                                                // leftovers from an earlier roll fade away
          const e = easeOut(Math.min(1, k / 0.4));
          die.mat.emissiveIntensity = st.em * (1 - e); aura.material.opacity = st.au * (1 - e);
          dimmer.material.opacity = st.dim * (1 - e); glow.intensity = st.gl * (1 - e); zoom = st.z * (1 - e);
          emoK = st.emo * (1 - e);
        }
      });
      height = 0; squash = 0;

      /* 3. TEETER (legendary+) */
      if (X.teeter) {
        const zoom0 = zoom, emT = die.mat.emissiveIntensity;
        timeScale = X.rainbow ? 0.28 : 0.38;
        const wob = new T.Quaternion();
        await tween(520, k => {
          die.mat.emissiveIntensity = emT + (0.22 + 0.12 * Math.sin(k * Math.PI * 8) - emT) * Math.min(1, k * 4);
          glow.intensity = 9;
          const ang = tilt * (1 - easeIn(k)) + 0.07 * Math.sin(k * Math.PI * 6) * (1 - k);
          body.quaternion.copy(wob.setFromAxisAngle(tAxis, ang)).multiply(target);
          zoom = zoom0 + (X.zoom - zoom0) * easeOut(Math.min(1, k * 1.6));
          dimmer.material.opacity = Math.max(dimmer.material.opacity, X.blackout * (0.7 + 0.3 * k));
        });
        timeScale = 1;
      }

      /* 4. IMPACT */
      body.quaternion.copy(target);
      setLabel(n);
      impact(n, X, col, target);
      return n;
    }

    function impact(n, X, col, target) {
      const rb = !!X.rainbow;
      shake = X.shake;
      flash.material.color.set(rb ? 0xffffff : col.clone().lerp(new T.Color(0xffffff), 0.6));
      flash.material.opacity = X.flash;
      for (let i = 0; i < X.rings; i++) ring(i % 2 && !rb ? 0xffffff : col.clone(), 2 + i * 1.3, 0.75 + i * 0.12, i * 0.09, rb, X.charge ? 0.95 : X.shake ? 0.7 : 0.45);
      burst(X.sparks, col, { min: 2 + X.shake * 2, max: 5 + X.shake * 5, rainbow: rb, life: 1.2 + X.shake * 0.5 });
      tween(380, k => { squash = (X.charge ? 0.22 : 0.1) * Math.sin(k * Math.PI) * (1 - k * 0.5); });
      const z0 = zoom, zPeak = z0 + X.zoom * 0.25;
      tween(1000, k => { zoom = k < 0.16 ? z0 + (zPeak - z0) * easeInOut(k / 0.16) : zPeak * (1 - easeInOut((k - 0.16) / 0.84)); });
      const wob = new T.Quaternion(), wAxis = new T.Vector3(1, 0, 0);
      tween(1600, k => { const s = k * 1.6; body.quaternion.copy(wob.setFromAxisAngle(wAxis, 0.09 * Math.sin(s * 22) * Math.exp(-s * 6))).multiply(target); });
      const d0 = dimmer.material.opacity, em0 = die.mat.emissiveIntensity, rest = rb ? 0.32 : X.gold ? 0.18 : 0;
      let age = 0;
      updaters.push(dt => {
        age += dt;
        flash.material.opacity *= Math.exp(-dt * (X.flash > 0.7 ? 3 : 6));
        const peak = Math.max(em0, X.glow), rise = easeOut(Math.min(1, age / 0.09));   // quick, but not a one-frame jump
        die.mat.emissiveIntensity = em0 + (rest + (peak - rest) * Math.exp(-age * 1.6) - em0) * rise;
        glow.intensity = (6 + X.shake * 14) * Math.exp(-age * 2);
        dimmer.material.opacity = d0 * Math.max(rb ? 0.45 : 0, 1 - easeInOut(Math.min(1, age / 1.6)));
        return age < 6;
      });
      if (X.rays) {
        rays.material.color.copy(col); rays2.material.color.copy(col);
        let a = 0;
        const keep = X.gold || rb ? 0.45 : 0;
        updaters.push((dt, now) => {
          a += dt;
          const pop = Math.min(1, a / 0.25);
          const level = a < 0.6 ? 1 : keep + (1 - keep) * Math.exp(-(a - 0.6) * 1.6);
          rays.material.opacity = 0.9 * easeOut(pop) * level;
          rays.scale.setScalar(1 + easeOut(pop) * (5 + X.rays * 2.5));
          rays.material.rotation += dt * 0.35;
          if (X.rays > 1) {
            rays2.material.opacity = rays.material.opacity * 0.7;
            rays2.scale.setScalar(rays.scale.x * 1.35);
            rays2.material.rotation -= dt * 0.22;
          }
          if (rb) { rays.material.color.setHSL((now / 2400) % 1, 1, 0.65); rays2.material.color.setHSL((now / 2400 + 0.5) % 1, 1, 0.65); }
          aura.material.opacity = 0.5 * rays.material.opacity; aura.material.color.copy(rays.material.color); aura.scale.setScalar(4);
          return true;
        });
      }
      if (X.gold) tween(900, k => { const e = easeInOut(k); die.mat.metalness = 0.05 + e * 0.55; die.mat.roughness = 0.28 - e * 0.1; });
      if (rb) {
        setColor(mix(color, "#ffffff", 0.45), 900);          // fades to a pearly base so the rainbow shows
        die.mat.iridescenceThicknessRange = [200, 900];
        tween(900, k => { die.mat.iridescence = Math.max(0.001, easeInOut(k)); });
        updaters.push((dt, now) => { emO.setHSL((now / 1600) % 1, 1, 0.6); emoK = approach(emoK, 1, 3, dt); return true; });
        tween(650, () => {}).then(() => {
          shake = X.shake * 0.6; flash.material.opacity = Math.max(flash.material.opacity, 0.6);
          for (let i = 0; i < 3; i++) ring(0xffffff, 3 + i * 1.6, 0.9, i * 0.08, true);
          burst(X.sparks * 0.6, col, { min: 3, max: 9, rainbow: true, life: 1.8 });
        });
      }
      if (X.embers) {
        let a = 0, acc = 0;
        const ec = X.gold ? new T.Color("#ffd27a") : col;
        updaters.push(dt => {
          a += dt; acc += X.embers * dt * Math.max(0, 1 - a / 5);
          while (acc > 1) { ember(ec, rb); acc--; }
          return a < 5;
        });
      }
    }

    return {
      roll,
      setColor,
      clearFx: () => clearFx(),
      spin(on) {
        clearFx(); if (on) setLabel(null);
        state = on ? "spin" : "idle"; spinTarget = on ? 14 : 0.5; bobTarget = on ? 0.12 : 0;
      },
      show(n, c) {
        clearFx(true); if (c) setColor(c); setLabel(n, true);
        state = "still"; height = 0; body.quaternion.copy(faceQuat(die.faces, n, view));
      },
      idle() { clearFx(); state = "idle"; spinTarget = 0.5; bobTarget = 0; },
      facing() {
        let best = null, bd = -2;
        die.faces.forEach(f => { const d = f.normal.clone().applyQuaternion(body.quaternion).dot(view); if (d > bd) { bd = d; best = f.n; } });
        return best;
      },
      _debug: () => ({ emo: emoK, h: height, q: body.quaternion.toArray(), light: cur.light.getHex(), num: die.U.num.value, em: die.mat.emissiveIntensity, met: die.mat.metalness, dim: dimmer.material.opacity, rays: rays.material.opacity, zoom }),
      canvas: cv,
      dispose() {
        alive = false; cancelAnimationFrame(raf); clearFx(true);
        die.tex.dispose(); die.mat.dispose(); die.mesh.geometry.dispose();
        renderer.dispose(); cv.remove();
      }
    };
  };

  api.snapshot = async function (n, color, px, style) {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:-9999px;top:0;width:" + px + "px;height:" + px + "px";
    document.body.appendChild(box);
    const d = await api.mount(box, { size: px, color, preserve: true, bleed: 1, style });
    d.show(n, color);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const url = d.canvas.toDataURL("image/png");
    d.dispose(); box.remove();
    return url;
  };

  api.load = load;
  return api;
})();
