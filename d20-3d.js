/* =====================================================================
   Study Atlas — 3D d20 for Lucky Roll
   A real icosahedron (20 faces) with numbers printed on the faces,
   a glossy gem finish, a tumble-and-bounce roll, and a landing that
   always shows the rolled number facing you, tinted by rarity.

   Three.js is only downloaded the first time the die is shown,
   so it doesn't slow down your page load.

   USE
     const die = await D20.mount(element, { size: 58, scale: 2.8, style: "one" });
       style "one" = your current look: blank faces, one big number on the front
       (leave style out for a classic die with all 20 numbers)
       size  = the element's CSS size in px
       scale = how much you scale the element up with CSS (keeps it sharp)
     die.spin(true)                    fast spin while you wait for a number
     await die.roll(17, "#b77cf2")     tumble, bounce, land on 17 (resolves on landing)
     die.setColor("#b9aeff")           change colour without rolling
     die.show(20)                      snap to a number, no animation
     die.dispose()                     remove it
     await D20.snapshot(20, "#b9aeff", 116, "one")   PNG data URL (for the small corner button)
   If WebGL or the download fails, mount() rejects: keep your SVG die as the fallback.
   ===================================================================== */
window.D20 = (function () {
  const api = { THREE_URL: "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js" };
  let T = null, loading = null;
  const load = () => loading || (loading = import(api.THREE_URL).then(m => (T = m)));

  /* ---------- colour helpers ---------- */
  function mix(hex, to, f) {
    const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
    const ch = (x, s) => (x >> s) & 255;
    const m = s => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * f);
    return "#" + ((1 << 24) | (m(16) << 16) | (m(8) << 8) | m(0)).toString(16).slice(1);
  }

  /* ---------- the number sheet (one triangle per face) ---------- */
  const CELL = 256, COLS = 5, ROWS = 4;
  const TRI = { ax: 0.5, ay: 0.08, lx: 0.04, ly: 0.877, rx: 0.96, ry: 0.877 };   // equilateral in a cell

  function paintAtlas(canvas, color, only) {           // only: undefined = all numbers, null = none, n = just n
    const c = canvas.getContext("2d");
    c.clearRect(0, 0, canvas.width, canvas.height);
    const light = mix(color, "#ffffff", 0.35), dark = mix(color, "#000000", 0.35);
    for (let n = 1; n <= 20; n++) {
      const i = n - 1, ox = (i % COLS) * CELL, oy = Math.floor(i / COLS) * CELL;
      const ax = ox + TRI.ax * CELL, ay = oy + TRI.ay * CELL;
      const lx = ox + TRI.lx * CELL, ly = oy + TRI.ly * CELL;
      const rx = ox + TRI.rx * CELL, ry = oy + TRI.ry * CELL;
      // face
      const g = c.createLinearGradient(ax, ay, ax, ly);
      g.addColorStop(0, light); g.addColorStop(1, dark);
      c.fillStyle = g;
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(lx, ly); c.lineTo(rx, ry); c.closePath(); c.fill();
      // soft inner bevel
      c.strokeStyle = "rgba(255,255,255,.18)"; c.lineWidth = 6; c.stroke();
      if (only !== undefined && only !== n) continue;     // "one number" style: blank faces
      // number at the centre of the triangle
      const cx = (ax + lx + rx) / 3, cy = (ay + ly + ry) / 3 + 4;
      const one = only !== undefined;
      c.font = "800 " + (one ? (n >= 10 ? 92 : 104) : (n >= 10 ? 74 : 86)) + "px system-ui, -apple-system, Segoe UI, sans-serif";
      c.textAlign = "center"; c.textBaseline = "middle";
      c.lineWidth = 10; c.strokeStyle = "rgba(10,10,30,.45)"; c.strokeText(String(n), cx, cy);
      c.fillStyle = "#ffffff"; c.fillText(String(n), cx, cy);
      if (!one && (n === 6 || n === 9)) { c.fillRect(cx - 18, cy + 40, 36, 7); }        // so 6 and 9 aren't confused
    }
  }

  /* ---------- build the die ---------- */
  function buildDie(color, label) {
    const geo = new T.IcosahedronGeometry(1, 0);           // 20 faces, 60 vertices (not shared)
    const pos = geo.attributes.position;
    const faces = [];
    for (let f = 0; f < 20; f++) {
      const a = new T.Vector3().fromBufferAttribute(pos, f * 3);
      const b = new T.Vector3().fromBufferAttribute(pos, f * 3 + 1);
      const c = new T.Vector3().fromBufferAttribute(pos, f * 3 + 2);
      const centre = a.clone().add(b).add(c).divideScalar(3);
      faces.push({ a, centre, normal: centre.clone().normalize(), up: a.clone().sub(centre).normalize(), n: 0 });
    }
    // real d20 layout: opposite faces add up to 21
    const order = [1, 7, 3, 9, 5, 10, 4, 8, 2, 6];        // each paired with 21 - n on the opposite face
    let k = 0;
    faces.forEach((fc, i) => {
      if (fc.n) return;
      const opp = faces.find((o, j) => j !== i && !o.n && o.normal.dot(fc.normal) < -0.99);
      fc.n = order[k]; opp.n = 21 - order[k]; k++;
    });
    // map each face to its number's triangle on the sheet
    const W = CELL * COLS, H = CELL * ROWS, uv = new Float32Array(120);
    faces.forEach((fc, f) => {
      const i = fc.n - 1, ox = (i % COLS) * CELL, oy = Math.floor(i / COLS) * CELL;
      const p = (x, y) => [(ox + x * CELL) / W, 1 - (oy + y * CELL) / H];
      uv.set([...p(TRI.ax, TRI.ay), ...p(TRI.lx, TRI.ly), ...p(TRI.rx, TRI.ry)], f * 6);
    });
    geo.setAttribute("uv", new T.BufferAttribute(uv, 2));

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    paintAtlas(canvas, color, label);
    const tex = new T.CanvasTexture(canvas);
    tex.colorSpace = T.SRGBColorSpace;
    tex.anisotropy = 8;

    const mat = new T.MeshPhysicalMaterial({
      map: tex, roughness: 0.28, metalness: 0.05,
      clearcoat: 1, clearcoatRoughness: 0.08,
      emissive: new T.Color(color), emissiveIntensity: 0
    });
    const mesh = new T.Mesh(geo, mat);
    const edges = new T.LineSegments(new T.EdgesGeometry(geo),
      new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28 }));
    edges.scale.setScalar(1.002);
    mesh.add(edges);
    return { mesh, mat, tex, canvas, faces };
  }

  /* soft studio lighting for the glossy reflections (no image files needed) */
  function studio(renderer) {
    const env = new T.Scene();
    env.add(new T.Mesh(new T.SphereGeometry(10, 32, 16), new T.MeshBasicMaterial({ color: 0x1a1f2b, side: T.BackSide })));
    const panel = (c, x, y, z, w, h) => {
      const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: c, side: T.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
    };
    panel(0xffffff, 0, 7, 3, 8, 3);      // soft box above
    panel(0xc9c0ff, -7, 2, 2, 3, 6);     // lavender strip left
    panel(0x8fc4f5, 7, 0, 2, 3, 6);      // blue strip right
    panel(0xf3a3c0, 0, -4, 6, 6, 1.5);   // pink kicker below
    const pm = new T.PMREMGenerator(renderer);
    const tex = pm.fromScene(env, 0.03).texture;
    pm.dispose();
    return tex;
  }

  /* ---------- maths: which way to turn so face n looks at you, upright ---------- */
  function faceQuat(faces, n, view) {
    const fc = faces.find(f => f.n === n);
    const q1 = new T.Quaternion().setFromUnitVectors(fc.normal, view);
    const up1 = fc.up.clone().applyQuaternion(q1);
    const want = new T.Vector3(0, 1, 0).sub(view.clone().multiplyScalar(view.y)).normalize();
    const ang = Math.atan2(view.dot(up1.clone().cross(want)), up1.dot(want));
    return new T.Quaternion().setFromAxisAngle(view, ang).multiply(q1);
  }

  const easeOut = t => 1 - Math.pow(1 - t, 3);

  /* ---------- mount ---------- */
  api.mount = async function (el, opts) {
    opts = opts || {};
    await load();
    const size = opts.size || el.clientWidth || 160;
    const bleed = opts.bleed || 1.8;                         // canvas is bigger than the box so bounces and glow never get cut off
    const px = Math.min(window.devicePixelRatio || 1, 2) * (opts.scale || 1);

    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance", preserveDrawingBuffer: !!opts.preserve });
    renderer.setPixelRatio(px);
    renderer.setSize(size * bleed, size * bleed);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.domElement.style.cssText = "position:absolute;left:50%;top:50%;width:" + size * bleed + "px;height:" +
      size * bleed + "px;transform:translate(-50%,-50%);pointer-events:none;display:block";
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    el.appendChild(renderer.domElement);

    const scene = new T.Scene();
    scene.environment = studio(renderer);
    const camera = new T.PerspectiveCamera(30, 1, 0.1, 50);
    camera.position.set(0, 0.9, 5.2).multiplyScalar(bleed);
    camera.lookAt(0, 0, 0);
    const view = camera.position.clone().normalize();

    const key = new T.DirectionalLight(0xffffff, 1.6); key.position.set(-2, 4, 3); scene.add(key);
    scene.add(new T.AmbientLight(0xffffff, 0.25));
    const glow = new T.PointLight(0xffffff, 0, 6); glow.position.set(0, 0, 2.2); scene.add(glow);

    // contact shadow under the die
    const sc = document.createElement("canvas"); sc.width = sc.height = 128;
    const sx = sc.getContext("2d"), rg = sx.createRadialGradient(64, 64, 0, 64, 64, 64);
    rg.addColorStop(0, "rgba(0,0,0,.55)"); rg.addColorStop(1, "rgba(0,0,0,0)");
    sx.fillStyle = rg; sx.fillRect(0, 0, 128, 128);
    const shadow = new T.Mesh(new T.PlaneGeometry(2.4, 2.4),
      new T.MeshBasicMaterial({ map: new T.CanvasTexture(sc), transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = -1.08;
    scene.add(shadow);

    let color = opts.color || "#b9aeff";
    const oneNumber = opts.style === "one";                  // "one" = like the old die: blank faces, one big number in front
    let label = oneNumber ? 20 : undefined;
    const die = buildDie(color, label);
    scene.add(die.mesh);
    die.mesh.quaternion.copy(faceQuat(die.faces, 20, view));
    die.mesh.rotateY(0.5); die.mesh.rotateX(-0.25);         // a nice idle angle

    let mode = "idle", anim = null, raf = 0, last = performance.now(), alive = true;
    const spinAxis = new T.Vector3(0.4, 1, 0.25).normalize();
    const tmpQ = new T.Quaternion();

    function frame(now) {
      if (!alive) return;
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (mode === "idle") {
        die.mesh.quaternion.premultiply(tmpQ.setFromAxisAngle(spinAxis, dt * 0.5));
      } else if (mode === "fast") {
        die.mesh.quaternion.premultiply(tmpQ.setFromAxisAngle(spinAxis, dt * 14));
        die.mesh.position.y = 0.12 * Math.sin(now / 90);
      } else if (mode === "roll" && anim) anim(now);
      const h = die.mesh.position.y;
      shadow.scale.setScalar(1 - Math.min(0.45, Math.max(0, h) * 0.35));
      shadow.material.opacity = 1 - Math.min(0.6, Math.max(0, h) * 0.45);
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);

    function repaint() { paintAtlas(die.canvas, color, label); die.tex.needsUpdate = true; }
    function setLabel(n) { if (oneNumber) { label = n; repaint(); } }
    function setColor(c) {
      color = c;
      paintAtlas(die.canvas, c, label);
      die.tex.needsUpdate = true;
      die.mat.emissive.set(c);
      glow.color.set(c);
    }

    function roll(n, c, o) {
      o = o || {};
      if (c) setColor(c);
      setLabel(null);                                        // blank while it tumbles
      const dur = o.duration || 1700;
      const target = faceQuat(die.faces, n, view);
      const start = die.mesh.quaternion.clone();
      const axis = new T.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const turns = Math.PI * 2 * (2.5 + Math.random());
      const big = o.big || n >= 17;                          // epic and up land harder and glow
      const t0 = performance.now();
      const path = new T.Quaternion(), wob = new T.Quaternion();
      const wobAxis = new T.Vector3(1, 0, 0);
      mode = "roll";
      return new Promise(resolve => {
        let landed = false;
        anim = now => {
          const t = Math.min(1, (now - t0) / dur);
          // tumble that slows down and ends exactly on the target face
          path.setFromAxisAngle(axis, turns * (1 - easeOut(t))).multiply(target);
          die.mesh.quaternion.copy(start).slerp(path, Math.min(1, t / 0.18));
          // drop and bounce (3 bounces, smaller each time)
          die.mesh.position.y = 1.1 * Math.abs(Math.cos(Math.PI * 2.5 * t)) * Math.pow(1 - t, 2.2);
          // squash a little on each impact
          const hit = Math.max(0, 1 - die.mesh.position.y * 6) * (1 - t);
          die.mesh.scale.set(1 + hit * 0.06, 1 - hit * 0.08, 1 + hit * 0.06);
          if (t >= 1 && !landed) {
            landed = true;
            die.mesh.scale.set(1, 1, 1); die.mesh.position.y = 0;
            setLabel(n);                                       // number appears on the landed face
            const t1 = performance.now();
            anim = now2 => {                               // settle wobble + rarity glow
              const s = (now2 - t1) / 1000;
              const w = 0.09 * Math.sin(s * 22) * Math.exp(-s * 6);
              die.mesh.quaternion.copy(wob.setFromAxisAngle(wobAxis, w)).multiply(target);
              const pulse = big ? 0.55 * Math.exp(-s * 2.2) + 0.12 : 0.18 * Math.exp(-s * 3);
              die.mat.emissiveIntensity = pulse;
              glow.intensity = (big ? 14 : 4) * Math.exp(-s * 2.5);
              if (s > 2.5) { die.mesh.quaternion.copy(target); anim = null; mode = "still"; }
            };
            resolve(n);
          }
        };
      });
    }

    return {
      roll, setColor,
      spin(on) { if (on) setLabel(null); mode = on ? "fast" : "idle"; if (!on) die.mesh.position.y = 0; die.mat.emissiveIntensity = 0; },
      show(n, c) { if (c) setColor(c); setLabel(n); mode = "still"; anim = null; die.mesh.position.y = 0; die.mesh.quaternion.copy(faceQuat(die.faces, n, view)); },
      idle() { mode = "idle"; die.mat.emissiveIntensity = 0; glow.intensity = 0; },
      facing() {                                            // which number is facing you right now
        let best = null, bd = -2;
        die.faces.forEach(f => { const d = f.normal.clone().applyQuaternion(die.mesh.quaternion).dot(view); if (d > bd) { bd = d; best = f.n; } });
        return best;
      },
      canvas: renderer.domElement,
      dispose() {
        alive = false; cancelAnimationFrame(raf);
        die.tex.dispose(); die.mat.dispose(); die.mesh.geometry.dispose();
        renderer.dispose(); renderer.domElement.remove();
      }
    };
  };

  /* a still picture of the die, for the small corner button */
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
