// Hermes Journey Galaxy: renders one or more `hermes journey --json` graphs as solar systems.
// Each journey is a star; skills and memories orbit it in the order they were learned.
// The idle loop runs by itself; drag, scroll, and click take over. See ARCHITECTURE.md.
import * as THREE from "./vendor/three.module.min.js";
import { EffectComposer, UnrealBloomPass, Pass, ShaderPass, FXAAShader, HorizontalBlurShader, VerticalBlurShader } from "./vendor/three.module.min.js";
import { glowTexture, sunTexture, planetTexture } from "./textures.js";
import { assignLooks } from "./palette.js";
import { loadJourneys, setupPanel } from "./app.js";

const Q = new URLSearchParams(location.search);
// ?tv hides the interaction hint (kiosks / TVs). ?q=hi renders at full resolution on 4K.
const TV = Q.has("tv");
// cap the drawing buffer at ~1440p worth of pixels so 4K TVs on weak GPUs stay smooth (?q=hi lifts the cap)
const pixelRatio = () => Math.min(devicePixelRatio, 2, Q.get("q") === "hi" ? 2 : Math.sqrt((2560 * 1440) / (innerWidth * innerHeight)));
let WIDE_DIST = 1280;
const SYS_GAP = 170, CORE_CLEAR = 470; // min empty space between system edges / from galaxy centre to a system edge
const ORB_R = 110, SYS_ORBIT = [420, 740], IDLE_MS = 25000, DIM = 0.75, BLUR = 1.5;
const BG = 1, FG = 2; // layer masks: background (blurred when focused) / active system (always sharp)
const dotUniforms = { uScale: { value: 500 } }; // shared by the distant-planet dot batches; set in resize()
// Soft round points. Sub-3px points snap pixel to pixel while the camera pans (reads as jitter), so tiny points
// are drawn at 3 px with proportionally lower alpha. nearFade fades points out as the camera gets close.
function softPoints({ size, color = 0xffffff, opacity = 1, vertexColors = false, attenuate = false, additive = false, nearFade = 0, maxPx = 64 }) {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: dotUniforms.uScale, uSize: { value: size }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uNear: { value: nearFade }, uMax: { value: maxPx } },
    defines: Object.assign({}, vertexColors ? { VCOL: 1 } : {}, attenuate ? { ATTEN: 1 } : {}),
    vertexShader: `uniform float uScale, uSize, uNear, uMax; varying vec3 vC; varying float vA;
      #ifdef VCOL
      attribute vec3 color;
      #endif
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.);
        #ifdef ATTEN
        float px = uSize * uScale / max(-mv.z, 1.);
        #else
        float px = uSize * uScale / 1158.;
        #endif
        float a = 1.;
        if (px < 3.) { a = min(1., px * px / 5.); px = 3.; }
        px = min(px, uMax);
        if (uNear > 0.) a *= smoothstep(uNear * .3, uNear, -mv.z);
        vA = a;
        #ifdef VCOL
        vC = color;
        #else
        vC = vec3(1.);
        #endif
        gl_PointSize = px; gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying vec3 vC; varying float vA;
      void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, .15, d) * vA * uOpacity; if (a < .003) discard; gl_FragColor = vec4(uColor * vC, a); }`,
    transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}
const ORIGIN = new THREE.Vector3();
const GLOW = glowTexture(0.25), GLOW_SOFT = glowTexture(0.45);
const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

const $ = (id) => document.getElementById(id);
const ui = { back: $("back-btn"), scrubWrap: $("scrub-wrap"), track: $("scrub-track"), fill: $("scrub-fill"),
  handle: $("scrub-handle"), ruler: $("timeline-ruler"), title: $("system-title"), name: $("system-name"),
  meta: $("system-meta"), caption: $("caption"), hint: $("hint"), hud: $("hud"),
  grow: $("grow"), growDate: $("grow-date"), growCount: $("grow-count"),
  compare: $("compare"), cTitle: $("compare-title"), cSub: $("compare-sub"), cRows: $("compare-rows") };
if (TV) ui.hint.style.display = "none";

// ---------- renderer / post ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(pixelRatio());
renderer.setClearColor(0x040a1c);
renderer.outputColorSpace = THREE.SRGBColorSpace;
$("canvas-wrap").appendChild(renderer.domElement);
const canvas = renderer.domElement;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 20000);
camera.position.set(0, 500, 1300);
const ambient = new THREE.AmbientLight(0x7a8cc0, 2.4);
ambient.layers.enableAll(); scene.add(ambient);

// Renders only the objects on the given layer mask. Background pass clears; foreground pass
// draws on top of the (blurred) background with a fresh depth buffer, so the active system is never blurred.
class LayerPass extends Pass {
  constructor(mask, clear) { super(); this.mask = mask; this.clear = clear; this.needsSwap = false; }
  render(r, writeBuffer, readBuffer) {
    const m = camera.layers.mask, ac = r.autoClear;
    camera.layers.mask = this.mask; r.autoClear = false;
    r.setRenderTarget(this.renderToScreen ? null : readBuffer);
    if (this.clear) r.clear(); else r.clearDepth();
    r.render(scene, camera);
    camera.layers.mask = m; r.autoClear = ac;
  }
}
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: Q.has("msaa") ? +Q.get("msaa") || 4 : 0 }));
const bgPass = new LayerPass(BG | FG, true), fgPass = new LayerPass(FG, false);
const blurs = [new ShaderPass(HorizontalBlurShader), new ShaderPass(VerticalBlurShader), new ShaderPass(HorizontalBlurShader), new ShaderPass(VerticalBlurShader)];
const bloom = new UnrealBloomPass(new THREE.Vector2(16, 9), 0.45, 0.45, 0.5);
const fxaa = new ShaderPass(FXAAShader);
// film: edge vignette + fine grain (cheap, always on)
const film = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, grain: { value: 0.028 }, vig: { value: 0.5 }, res: { value: new THREE.Vector2(1920, 1080) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time, grain, vig; uniform vec2 res; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 d = vUv - .5; vec3 col = texture2D(tDiffuse, vUv).rgb;
      col *= mix(1. - vig, 1., smoothstep(.92, .28, length(d * vec2(res.x / res.y, 1.) * .8)));
      col += (h(vUv * res + fract(time * 7.3) * 91.) - .5) * grain;
      gl_FragColor = vec4(col, 1.);
    }`,
});
[bgPass, ...blurs, fgPass, bloom, fxaa, film].forEach((p) => composer.addPass(p));
let blurAmt = 0;
function setBlur(a) {
  blurAmt = a; const on = a > 0.02;
  blurs.forEach((p, i) => { p.enabled = on; const k = (i < 2 ? 1 : 2) * a; if (p.uniforms.h) p.uniforms.h.value = k / innerWidth; else p.uniforms.v.value = k / innerHeight; });
  bgPass.mask = on ? BG : BG | FG; fgPass.enabled = on;
}
setBlur(0);
function resize() {
  // HUD is designed at 1920x1080; --u scales every CSS size so 1440p/4K screens look identical
  document.documentElement.style.setProperty("--u", Math.min(innerWidth / 1920, innerHeight / 1080).toFixed(4));
  document.querySelectorAll(".node-label,.system-label").forEach((el) => { el._mw = undefined; });
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio()); composer.setPixelRatio(pixelRatio());
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
  const pr = renderer.getPixelRatio();
  fxaa.material.uniforms.resolution.value.set(1 / (innerWidth * pr), 1 / (innerHeight * pr));
  film.uniforms.res.value.set(innerWidth * pr, innerHeight * pr);
  dotUniforms.uScale.value = (innerHeight * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  setBlur(blurAmt);
}
addEventListener("resize", resize); resize();

// ---------- starfield ----------
{
  const N = 5000, p = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 4000 + Math.random() * 6000, th = Math.random() * 6.283, ph = Math.acos(Math.random() * 2 - 1);
    p.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.5, r * Math.sin(ph) * Math.sin(th)], i * 3);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  const stars = new THREE.Points(g, softPoints({ color: 0xa8b8e8, size: 1.3, opacity: 0.7 }));
  scene.add(stars);
  // mid layer: fewer, brighter, slightly coloured
  const M = 1800, mp = new Float32Array(M * 3), mc = new Float32Array(M * 3), tints = [0xffffff, 0xbcd0ff, 0xffe6c8, 0x9fb8ff].map((c) => new THREE.Color(c));
  for (let i = 0; i < M; i++) {
    const r = 2600 + Math.random() * 2400, th = Math.random() * 6.283, ph = Math.acos(Math.random() * 2 - 1);
    mp.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.6, r * Math.sin(ph) * Math.sin(th)], i * 3);
    const c = tints[i % 4]; mc.set([c.r, c.g, c.b], i * 3);
  }
  const mg = new THREE.BufferGeometry(); mg.setAttribute("position", new THREE.BufferAttribute(mp, 3)); mg.setAttribute("color", new THREE.BufferAttribute(mc, 3));
  scene.add(new THREE.Points(mg, softPoints({ size: 2.4, vertexColors: true, opacity: 0.8 })));
}
// near motes + nebula clouds + spiral dust lanes are sized to the galaxy, so they're built after layout
const deco = new THREE.Group(); scene.add(deco);
const clouds = []; let motes = null;
function cloudTexture(seed) {
  const s = 256, c = document.createElement("canvas"); c.width = c.height = s; const g = c.getContext("2d");
  let r = seed * 9301 + 49297; const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 26; i++) {
    const x = s / 2 + (rnd() - 0.5) * s * 0.5, y = s / 2 + (rnd() - 0.5) * s * 0.5, rad = s * (0.12 + rnd() * 0.28);
    const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, `rgba(255,255,255,${0.09 + rnd() * 0.12})`); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function buildDepth(ext) {
  // spiral dust lanes in the galaxy plane (two arms, logarithmic)
  const N = 24000, p = new Float32Array(N * 3), col = new Float32Array(N * 3), r0 = CORE_CLEAR * 0.55, r1 = ext * 1.3;
  const ca = new THREE.Color(0x2a3f86), cb = new THREE.Color(0x9fb4ee), tmp = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const arm = i & 1, u = Math.random() ** 0.8, r = r0 + u * (r1 - r0);
    const th = arm * Math.PI + Math.log(r / r0) / Math.tan(0.32) + (Math.random() - 0.5) * 0.5;
    const w = (18 + r * 0.07) * (Math.random() + Math.random() - 1);
    p.set([Math.cos(th) * r - Math.sin(th) * w, (Math.random() - 0.5) * 16, Math.sin(th) * r + Math.cos(th) * w], i * 3);
    tmp.copy(ca).lerp(cb, Math.random() * 0.6 * (1 - u * 0.6)); col.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(p, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  deco.add(new THREE.Points(g, softPoints({ size: 1.8, vertexColors: true, opacity: 0.3, additive: true, nearFade: 140 })));
  // soft nebula clouds lying in the plane
  const texs = [1, 2, 3].map(cloudTexture), tints = [0x1f3fa8, 0x4a2a96, 0x0f5f78, 0x2b56d6, 0x6a2a8a].map((c) => new THREE.Color(c));
  for (let i = 0; i < 24; i++) {
    const a = Math.random() * 6.283, r = CORE_CLEAR * 0.5 + Math.random() * ext * 0.95;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: texs[i % 3], color: tints[i % tints.length], transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    sp.position.set(Math.cos(a) * r, (Math.random() - 0.5) * 50, Math.sin(a) * r); sp.scale.setScalar(380 + Math.random() * 620);
    sp.userData.base = 0.16 + Math.random() * 0.14; clouds.push(sp);
    sp.material.rotation = Math.random() * 6.283; deco.add(sp);
  }
  // near motes for parallax as the camera moves
  const K = 1400, kp = new Float32Array(K * 3);
  for (let i = 0; i < K; i++) { const a = Math.random() * 6.283, r = Math.random() * ext * 1.7; kp.set([Math.cos(a) * r, (Math.random() - 0.5) * 700, Math.sin(a) * r], i * 3); }
  const kg = new THREE.BufferGeometry(); kg.setAttribute("position", new THREE.BufferAttribute(kp, 3));
  motes = new THREE.Points(kg, softPoints({ color: 0x9fb4ff, size: 5, opacity: 0.2, attenuate: true, additive: true, nearFade: 320, maxPx: 7 }));
  scene.add(motes);
}

// ---------- core: blue orb with a faint emblem, inside a slow dust disk ----------
const core = { group: new THREE.Group(), form: 0.6, formTarget: 0.6, dim: 1, dimTarget: 1 };
scene.add(core.group);
function svgTexture(url, size) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = c.height = size;
      const g = c.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, size, size); g.drawImage(img, 0, 0, size, size);
      res(new THREE.CanvasTexture(c));
    };
    img.onerror = () => res(null); img.src = url;
  });
}
async function buildCore() {
  // orb: animated value-noise swirl + fresnel rim
  core.orbMat = new THREE.ShaderMaterial({
    uniforms: { t: { value: 0 }, dim: { value: 1 }, deep: { value: new THREE.Color(0x0d3fd0) }, bright: { value: new THREE.Color(0x8fbaff) } },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){ vec4 w = modelMatrix * vec4(position,1.); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - w.xyz); vP = position; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float t, dim; uniform vec3 deep, bright; varying vec3 vN, vV, vP;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
      float n(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
        return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x), mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x), f.y),
                   mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x), mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x), f.y), f.z); }
      void main(){
        float fr = pow(1. - max(dot(vN, vV), 0.), 2.2);
        vec3 p = normalize(vP) * 2.4;
        float sw = n(p + vec3(t*.05, t*.03, 0.)) * .6 + n(p*2.6 - vec3(0., t*.07, t*.04)) * .4;
        vec3 c = mix(deep, bright, .2 + .45*sw) + bright * fr * .8;
        gl_FragColor = vec4(c * dim, 1.);
      }`,
  });
  core.orb = new THREE.Mesh(new THREE.SphereGeometry(ORB_R, 64, 64), core.orbMat);
  scene.add(core.orb);

  // the emblem: luminance of web/emblem.svg, circle-masked, glowing faintly on the orb's face
  const tex = await svgTexture("emblem.svg", 1024);
  core.emblemMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, op: { value: 0.2 }, tint: { value: new THREE.Color(0x6f9cff) } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `uniform sampler2D map; uniform float op; uniform vec3 tint; varying vec2 vUv;
      void main(){ float m = smoothstep(.47, .30, length(vUv - .5)); float l = texture2D(map, vUv).r;
        gl_FragColor = vec4(tint * l * m * op, 1.); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const emblem = new THREE.Mesh(new THREE.PlaneGeometry(ORB_R * 1.95, ORB_R * 1.95), core.emblemMat);
  emblem.position.z = ORB_R * 1.02; emblem.renderOrder = 2; emblem.visible = !!tex;

  core.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: 0x3a74ff, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending }));
  core.halo.scale.setScalar(ORB_R * 6);
  core.group.add(core.halo, emblem);

  // dust disk around the core
  const N = 6000, p = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const a = new THREE.Color(0x2f62e8), b = new THREE.Color(0xbfd2ff);
  for (let i = 0; i < N; i++) {
    const r = ORB_R * 1.25 + Math.random() ** 1.8 * 280, th = Math.random() * 6.283 + r * 0.012;
    p.set([Math.cos(th) * r, (Math.random() - 0.5) * 14 * (1 - r / 420), Math.sin(th) * r], i * 3);
    const c = a.clone().lerp(b, Math.random() * 0.5 * (1 - r / 420)); col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  core.disk = new THREE.Points(g, new THREE.PointsMaterial({ size: 2.2, vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }));
  core.disk.rotation.x = 0; // coplanar with the systems, so it can never overlap them on screen
  scene.add(core.disk);
}
function updateCore(dt, t) {
  if (!core.orb) return;
  core.form += (core.formTarget - core.form) * Math.min(1, dt * 0.8);
  core.dim += (core.dimTarget - core.dim) * Math.min(1, dt * 2.5);
  core.group.quaternion.copy(camera.quaternion); // emblem + halo always face the viewer
  core.orbMat.uniforms.t.value = t; core.orbMat.uniforms.dim.value = core.dim;
  core.emblemMat.uniforms.op.value = (0.07 + 0.17 * core.form) * core.dim;
  core.halo.material.opacity = 0.35 * core.dim;
  core.disk.material.opacity = 0.6 * core.dim;
  core.disk.rotation.y += dt * 0.03;
}

// ---------- systems ----------
const systems = [];
const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const toMs = (v) => (typeof v === "number" ? (v > 1e12 ? v : v * 1000) : Date.parse(v));
const fade = (m, base) => { m.transparent = true; m.depthWrite = false; m.userData.base = base; m.opacity = base; return m; };
// Shared planet textures: 5 variants per color so ~1,500 planets don't each allocate their own canvas.
const texCache = new Map();
function planetTex(hex, isMem, h) {
  const key = `${hex}|${isMem}|${h % 5}`;
  if (!texCache.has(key)) texCache.set(key, planetTexture(hex, isMem));
  return texCache.get(key);
}

// Distant systems draw their planets as one batch of shaded dots (1 draw call) instead of ~200 meshes.
const dotMat = new THREE.ShaderMaterial({
  uniforms: dotUniforms,
  vertexShader: `uniform float uScale; attribute float size; attribute float alpha; attribute vec3 dcol; varying vec3 vC; varying float vA;
    void main(){ vC = dcol; vec4 mv = modelViewMatrix * vec4(position, 1.); float px = size * uScale / -mv.z, k = 1.; if (px < 3.) { k = min(1., px * px / 5.); px = 3.; } vA = alpha * k; gl_PointSize = px; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vC; varying float vA;
    void main(){ vec2 q = gl_PointCoord - .5; float d = length(q); if (d > .5 || vA < .01) discard;
      float lit = .8 + .55 * (.35 - q.y - q.x * .4);
      gl_FragColor = vec4(vC * lit * 1.25, vA * smoothstep(.5, .3, d)); }`,
  transparent: true, depthWrite: false,
});

// Each system gets its own kind of star so they read as different places.
function buildStar(type, color) {
  const g = new THREE.Group(), mats = [], spin = [];
  const add = (o, base, parent = g) => { fade(o.material, base); mats.push(o.material); parent.add(o); return o; };
  const sun = (r) => new THREE.Mesh(new THREE.SphereGeometry(r, 32, 32), new THREE.MeshBasicMaterial({ map: sunTexture(color), color: 0xe6e6e6 }));
  const additive = (m) => { m.blending = THREE.AdditiveBlending; return m; };
  if (type === "binary") {
    const pair = new THREE.Group(); g.add(pair);
    add(sun(4.4), 1, pair).position.x = 6; add(sun(3), 1, pair).position.x = -9;
    spin.push((dt) => (pair.rotation.y += dt * 0.5));
  } else add(sun(6), 1);
  const halo = new THREE.Sprite(additive(new THREE.SpriteMaterial({ map: GLOW, color })));
  halo.scale.setScalar(46); add(halo, 0.3);
  const beacon = add(new THREE.Sprite(additive(new THREE.SpriteMaterial({ map: GLOW_SOFT, color }))), 0.3);
  spin.push(() => { const d = camera.position.distanceTo(g.getWorldPosition(beacon.position.clone().set(0, 0, 0))); beacon.scale.setScalar(Math.max(0, d * 0.075 - 10)); });
  if (type === "corona") {
    const n = 56, p = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) { const a = (i / n) * 6.283, r1 = 12 + Math.random() * 14; p.set([Math.cos(a) * 7.5, Math.sin(a) * 7.5, 0, Math.cos(a) * r1, Math.sin(a) * r1, 0], i * 6); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(p, 3));
    const rays = add(new THREE.LineSegments(geo, additive(new THREE.LineBasicMaterial({ color }))), 0.5);
    let a = 0; spin.push((dt) => { a += dt * 0.08; rays.quaternion.copy(camera.quaternion); rays.rotateZ(a); });
  } else if (type === "pulsar") {
    const jets = new THREE.Group(); jets.rotation.z = 0.45; g.add(jets);
    [1, -1].forEach((s) => {
      const c = add(new THREE.Mesh(new THREE.ConeGeometry(2.4, 36, 20, 1, true), additive(new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }))), 0.28, jets);
      c.position.y = s * 20; c.rotation.x = s > 0 ? Math.PI : 0;
    });
    spin.push((dt) => (jets.rotation.y += dt * 1.1));
  } else if (type === "nebula") {
    const n = 600, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const r = 8 + Math.random() ** 0.6 * 22, a = Math.random() * 6.283; p.set([Math.cos(a) * r, (Math.random() - 0.5) * 9 * (1 - r / 32), Math.sin(a) * r], i * 3); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(p, 3));
    const cloud = add(new THREE.Points(geo, additive(new THREE.PointsMaterial({ color, size: 1 }))), 0.6);
    spin.push((dt) => (cloud.rotation.y += dt * 0.12));
  } else if (type === "ringed") {
    [[9, 11.2, 0.38], [12.6, 13.4, 0.24]].forEach(([r0, r1, o]) => {
      const r = add(new THREE.Mesh(new THREE.RingGeometry(r0, r1, 128), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })), o);
      r.rotation.x = Math.PI / 2 - 0.45;
    });
  }
  return { g, mats, spin };
}

// Place systems so no two footprints ever touch. All systems share one plane, so disjoint
// footprints stay disjoint on screen from any camera angle (perspective preserves it).
const footprint = (s) => s.outer + 32; // planets + star halo
function layoutSystems() {
  const n = systems.length, bySize = [...systems].sort((a, b) => b.outer - a.outer), slot = new Array(n);
  bySize.forEach((s, k) => (slot[k % 2 ? Math.ceil(n / 2) + (k >> 1) : k >> 1] = s)); // big systems opposite each other
  const P = slot.map((s, k) => { const a = (k / n) * 6.2832 + 0.3, r = CORE_CLEAR + footprint(s) + (k % 2) * 150; return { s, x: Math.cos(a) * r, z: Math.sin(a) * r }; });
  const separate = () => {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const A = P[i], B = P[j], need = footprint(A.s) + footprint(B.s) + SYS_GAP;
      const dx = B.x - A.x, dz = B.z - A.z, d = Math.hypot(dx, dz) || 1e-3;
      if (d < need) { const k = (need - d) / 2 / d; A.x -= dx * k; A.z -= dz * k; B.x += dx * k; B.z += dz * k; }
    }
    for (const p of P) { const d = Math.hypot(p.x, p.z) || 1e-3, min = CORE_CLEAR + footprint(p.s); if (d < min) { p.x *= min / d; p.z *= min / d; } }
  };
  for (let it = 0; it < 300; it++) { for (const p of P) { p.x *= 0.996; p.z *= 0.996; } separate(); } // gentle pull keeps it compact
  for (let it = 0; it < 200; it++) separate(); // final passes: constraints only
  let ext = 0, minGap = Infinity;
  for (const p of P) {
    p.s.orbitR = Math.hypot(p.x, p.z); p.s.orbitA = Math.atan2(p.z, p.x); p.s.y = 0;
    p.s.group.position.set(p.x, 0, p.z); ext = Math.max(ext, p.s.orbitR + footprint(p.s));
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++)
    minGap = Math.min(minGap, Math.hypot(P[i].x - P[j].x, P[i].z - P[j].z) - footprint(P[i].s) - footprint(P[j].s));
  // measured: 2.25x extent keeps every system inside 16:9 at every point of the camera orbit; small galaxies get closer
  WIDE_DIST = ext * 2.25;
  buildDepth(ext);
  window.__layout = { minGap: Math.round(minGap), extent: Math.round(ext), wide: Math.round(WIDE_DIST) };
}
function buildSystem(profile, i, total) {
  const color = new THREE.Color(profile.color), group = new THREE.Group();
  const s = { name: profile.name, color, group, dim: 1, dimTarget: 1, vis: 1, visTarget: 1, reveal: 1, bodies: [], byId: {}, edges: [],
    orbitR: SYS_ORBIT[0] + ((SYS_ORBIT[1] - SYS_ORBIT[0]) * (profile.orbitRank ?? i)) / Math.max(1, total - 1),
    orbitA: (i / total) * 6.283 + 0.3, orbitV: 0.006, y: 0 }; // one shared speed: the galaxy turns rigidly, spacing never changes
  const star = buildStar(profile.star, profile.color);
  group.add(star.g); s.mats = star.mats; s.spin = star.spin;
  s.light = new THREE.PointLight(0xffffff, 3.2, 260, 0); group.add(s.light);

  const nodes = profile.graph.nodes.filter((n) => n.timestamp).map((n) => ({ ...n, ts: toMs(n.timestamp) }));
  s.minT = Math.min(...nodes.map((n) => n.ts)); s.maxT = Math.max(...nodes.map((n) => n.ts));
  const span = Math.max(1, s.maxT - s.minT), R0 = 14, R1 = 52 + Math.sqrt(nodes.length) * 3.6;
  s.outer = R1; s.nSkills = nodes.filter((n) => n.kind === "skill").length; s.nMem = nodes.length - s.nSkills;
  const pal = (profile.palette || [profile.color]).map((c) => new THREE.Color(c));
  const memColor = pal[pal.length - 1].clone().lerp(new THREE.Color(0xffffff), 0.55);

  for (const n of nodes) {
    const ratio = (n.ts - s.minT) / span, radius = R0 + (0.06 + 0.94 * ratio) * (R1 - R0), h = hash(n.id);
    const isMem = n.kind === "memory", kc = isMem ? memColor : pal[(h >>> 4) % pal.length];
    const pr = isMem ? 0.7 : Math.min(3.2, 1.1 + Math.sqrt(n.use_count || 1) * 0.28);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(pr, 14, 12), new THREE.MeshStandardMaterial({
      map: planetTex(kc.getHex(), isMem, h), roughness: 0.7, metalness: 0.05,
      emissive: kc.clone().multiplyScalar(0.55), transparent: true, opacity: 0 }));
    // Pivot frame: the body sits at (radius,0,0) and the ring is drawn in the same plane,
    // so spinning the pivot keeps every sphere exactly on its orbit line.
    const pivot = new THREE.Object3D();
    pivot.rotation.set((((h >>> 8) % 1000) / 1000 - 0.5) * 0.3, ((h % 36000) / 36000) * 6.283, 0);
    mesh.position.x = radius; pivot.add(mesh); group.add(pivot);
    let ring = null;
    if (!isMem) {
      ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.08, radius + 0.08, 96),
        new THREE.MeshBasicMaterial({ color: kc, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = Math.PI / 2; ring.visible = false; pivot.add(ring);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW_SOFT, color: kc, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.setScalar(pr * 8); mesh.add(glow);
    const b = { node: n, ratio, mesh, pivot, ring, glow, isMem, kc, lp: new THREE.Vector3(), links: [], hi: 0, speed: (0.25 / Math.sqrt(radius)) * (0.8 + (h % 100) / 250) };
    s.bodies.push(b); s.byId[n.id] = b;
  }
  {
    const sk = s.bodies.filter((b) => !b.isMem).sort((a, b) => a.ratio - b.ratio), SEG = 72;
    const pos = new Float32Array(sk.length * SEG * 6), col = new Float32Array(sk.length * SEG * 6), A = new THREE.Vector3(), B = new THREE.Vector3();
    let k = 0;
    for (const b of sk) {
      b.pivot.updateMatrix(); const r = b.mesh.position.x;
      for (let j = 0; j < SEG; j++) {
        const a0 = (j / SEG) * 6.2832, a1 = ((j + 1) / SEG) * 6.2832;
        A.set(Math.cos(a0) * r, 0, Math.sin(a0) * r).applyMatrix4(b.pivot.matrix); B.set(Math.cos(a1) * r, 0, Math.sin(a1) * r).applyMatrix4(b.pivot.matrix);
        pos.set([A.x, A.y, A.z, B.x, B.y, B.z], k); col.set([b.kc.r, b.kc.g, b.kc.b, b.kc.r, b.kc.g, b.kc.b], k); k += 6;
      }
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    s.rings = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false }));
    s.ringRatios = sk.map((b) => b.ratio); s.ringVerts = SEG * 2; group.add(s.rings);
  }
  for (const e of profile.graph.edges || []) {
    const a = s.byId[e.source], b = s.byId[e.target];
    if (!a || !b || a === b) continue;
    s.edges.push({ a, b }); a.links.push(b); b.links.push(a);
  }
  {
    const N = s.bodies.length, dg = new THREE.BufferGeometry(), dc = new Float32Array(N * 3), ds = new Float32Array(N);
    s.bodies.forEach((b, i) => { dc.set([b.kc.r, b.kc.g, b.kc.b], i * 3); ds[i] = b.mesh.geometry.parameters.radius * 2.3; });
    dg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3)); dg.setAttribute("dcol", new THREE.BufferAttribute(dc, 3));
    dg.setAttribute("size", new THREE.BufferAttribute(ds, 1)); dg.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(N), 1));
    s.dots = new THREE.Points(dg, dotMat); s.dots.frustumCulled = false; group.add(s.dots);
  }
  // stats for the comparison beat + birth order for the galaxy-grows beat
  s.byTime = [...s.bodies].sort((a, b) => a.node.ts - b.node.ts);
  const topSkill = s.bodies.filter((b) => !b.isMem).sort((a, b) => (b.node.use_count || 0) - (a.node.use_count || 0))[0];
  s.stats = { skills: s.nSkills, links: s.edges.length, topUse: topSkill ? topSkill.node.use_count || 0 : 0, topName: topSkill ? topSkill.node.label : "" };
  // faint web of every link (shown while the system is in focus)
  s.web = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(s.edges.length * 6), 3)),
    new THREE.LineBasicMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.4), transparent: true, opacity: 0, depthWrite: false }));
  s.web.frustumCulled = false; group.add(s.web);
  // pool of bright arcs + travelling sparks for the selected node's links
  s.arcs = Array.from({ length: 10 }, () => {
    const line = new THREE.Line(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(24 * 3), 3)),
      new THREE.LineBasicMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.6), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    const spark = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: color.clone().lerp(new THREE.Color(0xffffff), 0.8), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    line.frustumCulled = false; spark.scale.setScalar(3.5); group.add(line, spark);
    return { line, spark };
  });
  group.position.set(Math.cos(s.orbitA) * s.orbitR, s.y, Math.sin(s.orbitA) * s.orbitR);
  scene.add(group);
  s.label = document.createElement("div"); s.label.className = "system-label"; s.label.textContent = profile.name;
  s.label.style.color = `#${color.clone().lerp(new THREE.Color(0xffffff), 0.2).getHexString()}`;
  s.label.style.textShadow = `0 0 10px #${color.getHexString()}aa`;
  ui.hud.appendChild(s.label);
  systems.push(s);
}

// ---------- focus / selection ----------
let focus = null, selected = null, selectedAt = 0;
const clock = new THREE.Clock();
function select(b) { selected = b || null; selectedAt = clock.elapsedTime; }
const setLayer = (g, n) => g.traverse((o) => o.layers.set(n));
function setFocus(s) {
  if (focus) setLayer(focus.group, 0);
  focus = s; select(null); setLayer(s.group, 1);
  ui.compare.classList.remove("visible"); // entering a system always clears the comparison board
  systems.forEach((o) => (o.dimTarget = o === s ? 1 : DIM)); core.dimTarget = DIM;
  ui.name.textContent = s.name;
  ui.fill.style.background = `linear-gradient(90deg,#${s.color.getHexString()},#${s.color.clone().lerp(new THREE.Color(0xffffff), 0.5).getHexString()})`;
  ui.meta.textContent = `${s.nSkills} SKILLS  ·  ${s.nMem} MEMORIES  ·  ${Math.round((s.maxT - s.minT) / 864e5)} DAYS`;
  ui.title.classList.add("visible"); ui.scrubWrap.classList.add("visible");
  buildRuler(s);
}
function clearFocus() {
  if (focus) setLayer(focus.group, 0);
  focus = null; select(null);
  systems.forEach((o) => (o.dimTarget = 1)); core.dimTarget = 1;
  ui.title.classList.remove("visible"); ui.scrubWrap.classList.remove("visible");
}

// ---------- per-frame system update ----------
const v = new THREE.Vector3(), v2 = new THREE.Vector3(), mid = new THREE.Vector3(), P = new THREE.Vector3();
function updateSystems(dt, t) {
  deco.rotation.y -= dt * 0.006; // dust lanes + clouds turn with the galaxy
  for (const c of clouds) { // fade each cloud out well before the camera reaches it (no hard cut when flying through)
    const s = c.scale.x, d = camera.position.distanceTo(c.getWorldPosition(v));
    c.material.opacity = c.userData.base * THREE.MathUtils.smoothstep(d, s * 0.35, s * 1.1);
    c.visible = c.material.opacity > 0.002;
  }
  for (const s of systems) {
    s.orbitA += dt * s.orbitV;
    s.group.position.set(Math.cos(s.orbitA) * s.orbitR, s.y, Math.sin(s.orbitA) * s.orbitR);
    s.spin.forEach((f) => f(dt));
    s.dim += (s.dimTarget - s.dim) * Math.min(1, dt * 2.5);
    s.vis += (s.visTarget - s.vis) * Math.min(1, dt * 3);
    for (const m of s.mats) m.opacity = m.userData.base * s.dim * s.vis;
    s.light.intensity = 3.2 * s.dim * s.vis;
    const inFocus = s === focus, nbs = inFocus && selected ? selected.links : null;
    let nr = 0; while (nr < s.ringRatios.length && s.ringRatios[nr] <= s.reveal + 1e-4) nr++;
    s.rings.geometry.setDrawRange(0, nr * s.ringVerts);
    s.rings.material.opacity = (inFocus ? (selected ? 0.2 : 0.3) : 0.14) * s.dim * s.vis;
    const lodMesh = inFocus || camera.position.distanceTo(s.group.position) < s.outer * 6;
    const dpos = s.dots.geometry.attributes.position, dal = s.dots.geometry.attributes.alpha;
    s.dots.visible = !lodMesh;
    for (let i = 0; i < s.bodies.length; i++) {
      const b = s.bodies[i];
      b.pivot.rotation.y += dt * b.speed; b.mesh.rotation.y += dt * 0.5;
      b.pivot.updateMatrix(); b.lp.set(b.mesh.position.x, 0, 0).applyMatrix4(b.pivot.matrix); // system-local position, reused by links + dots
      const shown = b.ratio <= s.reveal + 1e-4, sel = b === selected, nb = nbs && nbs.includes(b);
      b.hi += ((sel ? 1 : nb ? 0.6 : 0) - b.hi) * Math.min(1, dt * 6);
      const quiet = inFocus && selected && !sel && !nb ? 0.65 : 1;
      const op = shown ? (b.isMem ? 0.85 : 0.95) * s.dim * quiet : 0;
      b.mesh.material.opacity += (op - b.mesh.material.opacity) * Math.min(1, dt * 5);
      b.mesh.visible = lodMesh && b.mesh.material.opacity > 0.01;
      if (!lodMesh) { dpos.setXYZ(i, b.lp.x, b.lp.y, b.lp.z); dal.setX(i, b.mesh.material.opacity); }
      if (b.ring) { b.ring.visible = shown && b.hi > 0.01; b.ring.material.opacity = 0.5 * b.hi * s.dim; }
      b.glow.material.opacity = b.hi * 0.45 * s.dim; b.glow.visible = b.hi > 0.01;
      b.mesh.scale.setScalar(1 + b.hi * 0.7);
    }
    if (!lodMesh) { dpos.needsUpdate = true; dal.needsUpdate = true; }
  }
}
const bez = (a, m, b, u, out) => { const i = 1 - u; return out.set(i*i*a.x + 2*i*u*m.x + u*u*b.x, i*i*a.y + 2*i*u*m.y + u*u*b.y, i*i*a.z + 2*i*u*m.z + u*u*b.z); };
const local = (b, s, out) => s.group.worldToLocal(b.mesh.getWorldPosition(out));
function updateEdges(t) {
  for (const s of systems) {
    const on = s === focus, webTarget = on ? (selected ? 0.15 : 0.4) : 0;
    s.web.material.opacity += (webTarget - s.web.material.opacity) * 0.08;
    if (s.web.material.opacity > 0.004) {
      const wa = s.web.geometry.attributes.position.array; let k = 0;
      for (const e of s.edges) {
        v.copy(e.a.lp); v2.copy(e.b.lp);
        if (e.a.ratio > s.reveal || e.b.ratio > s.reveal) v2.copy(v);
        wa[k++] = v.x; wa[k++] = v.y; wa[k++] = v.z; wa[k++] = v2.x; wa[k++] = v2.y; wa[k++] = v2.z;
      }
      s.web.geometry.attributes.position.needsUpdate = true;
    }
    const act = on && selected ? selected.links.filter((b) => b.ratio <= s.reveal).slice(0, s.arcs.length) : [];
    const grow = Math.min(1, (t - selectedAt) * 1.4);
    s.arcs.forEach((arc, i) => {
      const to = act[i];
      arc.line.material.opacity += ((to ? 0.75 : 0) - arc.line.material.opacity) * 0.15;
      arc.spark.material.opacity = to && grow >= 1 ? 0.9 : 0;
      if (!to) return;
      v.copy(selected.lp); v2.copy(to.lp);
      mid.copy(v).add(v2).multiplyScalar(0.5); mid.y += v.distanceTo(v2) * 0.25;
      const pa = arc.line.geometry.attributes.position;
      for (let j = 0; j < pa.count; j++) { bez(v, mid, v2, (j / (pa.count - 1)) * grow, P); pa.setXYZ(j, P.x, P.y, P.z); }
      pa.needsUpdate = true;
      bez(v, mid, v2, (t * 0.45 + i * 0.13) % 1, P); arc.spark.position.copy(P);
    });
  }
}

// ---------- DOM labels (positioned once per frame, after the camera moves) ----------
const mkLabel = (cls) => { const e = document.createElement("div"); e.className = cls; ui.hud.appendChild(e); return e; };
const nodeLabel = mkLabel("node-label"), nbLabels = Array.from({ length: 6 }, () => mkLabel("node-label small"));
const sp = {};
function toScreen(obj, out) {
  obj.getWorldPosition(v).project(camera);
  out.x = ((v.x * 0.5 + 0.5) * innerWidth).toFixed(1); out.y = ((-v.y * 0.5 + 0.5) * innerHeight).toFixed(1); out.ok = v.z < 1;
  return out;
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmtDate = (ms) => { const d = new Date(ms); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
function place(el, p, html, dy = -135) {
  if (!p.ok) return el.classList.remove("visible");
  if (el._h !== html) { el.innerHTML = html; el._h = html; }
  el.style.transform = `translate(${p.x}px,${p.y}px) translate(-50%,${dy}%)`;
  el.classList.add("visible");
}
function updateLabels() {
  const showSys = !focus && seq.phase !== "core";
  for (const s of systems) {
    toScreen(s.group, sp);
    if (showSys && sp.ok && s.vis > 0.5 && seq.phase !== "compare") place(s.label, sp, s.name, -230); else s.label.classList.remove("visible");
  }
  if (focus && selected) {
    const n = selected.node, c = selected.links.length;
    toScreen(selected.mesh, sp);
    place(nodeLabel, sp, `<div class="nl-title">${esc(n.label)}</div><div class="nl-meta">${selected.isMem ? "MEMORY" : "SKILL"}  ·  ${fmtDate(n.ts)}${!selected.isMem && n.use_count ? `  ·  USED ${n.use_count}×` : ""}<br>${c} CONNECTION${c === 1 ? "" : "S"}</div>`);
  } else nodeLabel.classList.remove("visible");
  const nbs = focus && selected && clock.elapsedTime - selectedAt > 0.7 ? selected.links.filter((b) => b.ratio <= focus.reveal) : [];
  // Neighbour labels never overlap: skills first, each tries a few vertical offsets (last good one first,
  // so nothing flickers), and anything that still collides is hidden.
  const placed = [];
  const box = (el, p, dyFrac) => { if (el._mw === undefined || el._mh !== el._h) { el._mw = el.offsetWidth; el._mhH = el.offsetHeight; el._mh = el._h; }
    const w = el._mw, h = el._mhH; return { x: +p.x - w / 2, y: +p.y + h * dyFrac, w, h }; };
  const hit = (r) => placed.some((q) => r.x < q.x + q.w + 8 && q.x < r.x + r.w + 8 && r.y < q.y + q.h + 6 && q.y < r.y + r.h + 6);
  if (nodeLabel.classList.contains("visible")) placed.push(box(nodeLabel, sp, -1.35));
  const order = [...nbs].sort((a, b) => a.isMem - b.isMem || b.links.length - a.links.length).slice(0, nbLabels.length);
  nbLabels.forEach((el, i) => {
    const b = order[i];
    if (!b) return el.classList.remove("visible");
    const p = toScreen(b.mesh, {});
    if (!p.ok) return el.classList.remove("visible");
    const html = esc(b.node.label);
    if (el._h !== html) { el.innerHTML = html; el._h = html; el._off = 0; }
    const base = box(el, p, -1.7), offs = [el._off || 0, 0, -1.15, 1.15, -2.3, 2.3];
    let ok = null;
    for (const o of offs) { const r = { ...base, y: base.y + o * base.h }; if (!hit(r)) { ok = r; el._off = o; break; } }
    if (!ok) return el.classList.remove("visible");
    placed.push(ok);
    el.style.transform = `translate(${ok.x.toFixed(1)}px,${ok.y.toFixed(1)}px)`;
    el.classList.add("visible");
  });
}

// ---------- timeline ruler + scrub ----------
function buildRuler(s) {
  ui.ruler.innerHTML = "";
  const span = Math.max(1, s.maxT - s.minT), days = span / 864e5, step = days > 240 ? 10 : days > 90 ? 5 : 1;
  const add = (cls, ratio, text) => { const e = document.createElement("div"); e.className = cls; e.style.left = `${ratio * 100}%`; if (text) e.textContent = text; ui.ruler.appendChild(e); };
  const start = new Date(s.minT);
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)), lastLabel = -1;
  while (cur.getTime() <= s.maxT) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const r = (cur.getTime() - s.minT) / span;
    if (r >= 0) { add("tl-month-tick", r); if (r - lastLabel > 0.07) { add("tl-month", r, `${MONTHS[cur.getUTCMonth()]} ${cur.getUTCFullYear()}`); lastLabel = r; } }
    for (let d = step; d < 31; d += step) {
      const dt = cur.getTime() + d * 864e5;
      if (dt >= next.getTime()) break;
      if (dt >= s.minT && dt <= s.maxT) add("tl-day-tick", (dt - s.minT) / span);
    }
    cur = next;
  }
}
const setScrub = (r) => { ui.fill.style.width = `${r * 100}%`; ui.handle.style.left = `${r * 100}%`; };
let scrubbing = false;
const scrubTo = (x) => { const r = ui.track.getBoundingClientRect(); if (focus) focus.reveal = THREE.MathUtils.clamp((x - r.left) / r.width, 0, 1); };
ui.track.addEventListener("pointerdown", (e) => { wake(); scrubbing = true; scrubTo(e.clientX); });

// ---------- camera rig (everything eases toward a goal, so nothing snaps or jitters) ----------
const camGoal = new THREE.Vector3(), lookGoal = new THREE.Vector3(), lookAt = new THREE.Vector3();
const orbitPos = (c, d, th, ph, out) => out.set(c.x + d * Math.sin(ph) * Math.cos(th), c.y + d * Math.cos(ph), c.z + d * Math.sin(ph) * Math.sin(th));
function rig(dt, k) { const a = 1 - Math.exp(-dt * k); camera.position.lerp(camGoal, a); lookAt.lerp(lookGoal, a); camera.lookAt(lookAt); camera.updateMatrixWorld(); }
function frameNode(s) { // nudge the view toward the selected node
  lookGoal.copy(s.group.position);
  if (selected) lookGoal.lerp(selected.mesh.getWorldPosition(v), 0.22);
}

// ---------- idle demo sequencer ----------
const CAP = {
  wide: "Hermes is the agent that grows with you.",
  galaxy: "Each system is one Hermes, shaped by what it has learned.",
  core: "Every journey starts from the same agent.",
  timeline: "Skills and memories appear in the order Hermes learned them, oldest at the center.",
  tour: "Memories link to the skills that use them, and related skills link to each other.",
  grow0: "Every Hermes starts empty.",
  grow1: "This is every journey growing at once, day by day.",
  compare: "How the journeys compare.",
};
const SOLO = { galaxy: "This is your Hermes, shaped by what it has learned.", grow1: "This is your journey growing, day by day." };
// beat rotation after each wide shot; the loop opens with the galaxy growing
let BEATS = ["sys", "sys", "core", "sys", "compare", "sys", "sys", "grow"];
const DIVE_T = 7.5, GROW_T = 17, BOARD_T = 6.5;
const seq = { phase: "grow", t: 0, idx: -1, beat: 0, left: 0, next: 0, theta: 0.6, from: null, g: null, board: -1 };
const go = (p) => { seq.phase = p; seq.t = 0; seq.from = null; seq.board = -1; };
function caption(txt) {
  const c = ui.caption;
  if (c._t === txt) return;
  c._t = txt; c.classList.remove("show"); clearTimeout(c._to);
  c._to = setTimeout(() => { c.textContent = txt; if (txt) c.classList.add("show"); }, 500);
}
function pickInteresting(s) {
  const pool = s.bodies.filter((b) => b.links.length && b !== selected).sort((a, b) => b.links.length - a.links.length);
  const top = pool.slice(0, Math.max(8, pool.length >> 1));
  return top[(Math.random() * top.length) | 0] || s.bodies[0];
}
const smooth = (x) => x * x * (3 - 2 * x);

// birth flares for the galaxy-grows beat
const flares = Array.from({ length: 64 }, () => {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  sp.visible = false; scene.add(sp); return { sp, life: 0, big: 1 };
});
function flare(b) {
  const f = flares.find((x) => x.life <= 0); if (!f) return;
  f.life = 1; f.big = b.isMem ? 0.6 : 1 + Math.min(1.2, Math.sqrt(b.node.use_count || 1) / 25);
  b.mesh.getWorldPosition(f.sp.position); f.sp.material.color.copy(b.kc).lerp(WHITE, 0.45); f.sp.visible = true;
}
const WHITE = new THREE.Color(0xffffff);
function updateFlares(dt) {
  for (const f of flares) {
    if (f.life <= 0) continue;
    f.life -= dt * 1.1; const k = 1 - Math.max(0, f.life);
    f.sp.scale.setScalar((14 + 46 * smooth(k)) * f.big); f.sp.material.opacity = Math.max(0, f.life) ** 1.5;
    if (f.life <= 0) f.sp.visible = false;
  }
}
function startGrow() {
  const t0 = Math.min(...systems.map((s) => s.minT)), t1 = Math.max(t0 + 864e5, ...systems.map((s) => s.maxT));
  seq.g = { t0, t1, skills: 0, mems: 0 };
  for (const s of systems) { s.reveal = 0; s.visTarget = 0; s.vis = 0; s.gi = 0; }
  ui.grow.classList.add("visible");
}
function endGrow() {
  for (const s of systems) { s.reveal = 1; s.visTarget = 1; }
  seq.g = null; ui.grow.classList.remove("visible");
}
const fmtN = (n) => n.toLocaleString("en-US");
function showBoard(k) {
  const B = [
    { title: "MOST SKILLS", sub: "SKILLS EACH HERMES HAS LEARNED", val: (s) => s.stats.skills, txt: (s) => fmtN(s.stats.skills) },
    { title: "MOST CONNECTED", sub: "LINKS BETWEEN SKILLS AND MEMORIES", val: (s) => s.stats.links, txt: (s) => fmtN(s.stats.links) },
    { title: "MOST USED SKILL", sub: "THE MOST USED SKILL IN EACH JOURNEY", val: (s) => s.stats.topUse, txt: (s) => `${fmtN(s.stats.topUse)}  ·  ${esc(s.stats.topName.length > 34 ? s.stats.topName.slice(0, 32) + "…" : s.stats.topName)}` },
  ][k];
  const rows = [...systems].sort((a, b) => B.val(b) - B.val(a)), max = Math.max(1, ...rows.map(B.val));
  ui.cTitle.textContent = B.title; ui.cSub.textContent = B.sub;
  ui.cRows.innerHTML = rows.map((s) => {
    const c = `#${s.color.getHexString()}`, light = `#${s.color.clone().lerp(WHITE, 0.4).getHexString()}`;
    return `<div class="crow"><div class="who" style="color:${light}">${esc(s.name)}</div><div class="lane"><div class="bar" style="background:linear-gradient(90deg,${c}cc,${c});box-shadow:0 0 14px ${c}66" data-w="${(B.val(s) / max) * 62}"></div><div class="val" style="left:0" data-w="${(B.val(s) / max) * 62}">${B.txt(s)}</div></div></div>`;
  }).join("");
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ui.cRows.querySelectorAll(".bar").forEach((e) => (e.style.width = `${e.dataset.w}%`));
    ui.cRows.querySelectorAll(".val").forEach((e) => (e.style.left = `${e.dataset.w}%`));
  }));
}
const curve = new THREE.CatmullRomCurve3(Array.from({ length: 5 }, () => new THREE.Vector3()), false, "centripetal");
// dive timing: quick approach (to u=.5), slow skim inside the rings (to u=.75), then rise to the tour orbit
const diveU = (x) => (x < 0.3 ? smooth(x / 0.3) * 0.5 : x < 0.72 ? 0.5 + ((x - 0.3) / 0.42) * 0.25 : 0.75 + smooth((x - 0.72) / 0.28) * 0.25);
function nextBeat() {
  const b = BEATS[seq.beat++ % BEATS.length];
  if (b === "sys") { seq.idx = (seq.idx + 1) % systems.length; setFocus(systems[seq.idx]); focus.reveal = 1; go("dive"); }
  else go(b);
}
function wideCam(t) { orbitPos(ORIGIN, WIDE_DIST + Math.sin(t * 0.05) * WIDE_DIST * 0.03, seq.theta, 1.05 + Math.sin(t * 0.03) * 0.08, camGoal); lookGoal.set(0, -WIDE_DIST * 0.05, 0); }
function updateDemo(dt, t) {
  seq.t += dt; seq.theta += dt * 0.04;
  const p = seq.phase;
  if (p === "wide") {
    wideCam(t);
    core.formTarget = 0.62 + 0.33 * (Math.sin(t * 0.25) * 0.5 + 0.5);
    caption(seq.t < 6.5 ? CAP.wide : CAP.galaxy);
    if (seq.t > 13) nextBeat();
  } else if (p === "grow") {
    if (!seq.g) startGrow();
    wideCam(t); core.formTarget = 0.7;
    const g = seq.g, T = g.t0 + (g.t1 - g.t0) * smooth(Math.min(1, seq.t / GROW_T));
    let budget = 8;
    for (const s of systems) {
      if (T >= s.minT) s.visTarget = 1;
      s.reveal = THREE.MathUtils.clamp((T - s.minT) / Math.max(1, s.maxT - s.minT), 0, 1);
      while (s.gi < s.byTime.length && s.byTime[s.gi].node.ts <= T) {
        const b = s.byTime[s.gi++]; b.isMem ? g.mems++ : g.skills++;
        if (budget-- > 0) flare(b);
      }
    }
    ui.growDate.textContent = fmtDate(T);
    ui.growCount.textContent = `${fmtN(g.skills)} SKILLS  ·  ${fmtN(g.mems)} MEMORIES`;
    caption(seq.t < 6 ? CAP.grow0 : CAP.grow1);
    if (seq.t > GROW_T + 2.5) { endGrow(); go("wide"); seq.t = 6.5; }
  } else if (p === "compare") {
    wideCam(t); caption(CAP.compare);
    if (seq.board === -1) { systems.forEach((s) => (s.dimTarget = 0.45)); core.dimTarget = 0.45; ui.compare.classList.add("visible"); }
    const k = Math.floor(seq.t / BOARD_T);
    if (k !== seq.board && k < 3) { seq.board = k; showBoard(k); }
    if (seq.t > BOARD_T * 3) { ui.compare.classList.remove("visible"); systems.forEach((s) => (s.dimTarget = 1)); core.dimTarget = 1; go("wide"); seq.t = 6.5; }
  } else if (p === "core") {
    orbitPos(ORIGIN, 470, seq.theta, 1.5, camGoal); lookGoal.set(0, 15, 0);
    core.formTarget = 0.97; caption(CAP.core);
    if (seq.t > 9) go("wide"), (seq.t = 6.5);
  } else if (p === "dive") {
    // fly in low across the ring plane, skim through the outer orbits, then rise to the tour orbit
    const s = focus, c = s.group.position, o = s.outer;
    if (!seq.from) seq.from = camera.position.clone();
    orbitPos(c, o * 2.75, seq.theta * 2.5, 0.92, v2);
    const dir = v.copy(seq.from).sub(c); dir.y = 0; dir.normalize();
    const side = mid.set(-dir.z, 0, dir.x);
    const [p0, p1, p2, p3, p4] = curve.points;
    p0.copy(seq.from);
    p1.copy(c).addScaledVector(dir, o * 3.2).addScaledVector(side, o * 0.5); p1.y = c.y + o * 0.45;
    p2.copy(c).addScaledVector(dir, o * 1.05).addScaledVector(side, o * 0.35); p2.y = c.y + o * 0.05;   // enter the ring plane
    p3.copy(c).addScaledVector(dir, o * 0.35).addScaledVector(side, o * 0.95); p3.y = c.y + o * 0.09;   // sweep sideways through the orbits
    p4.copy(v2);
    curve.getPoint(diveU(Math.min(1, seq.t / DIVE_T)), camGoal);
    lookGoal.copy(c); core.formTarget = 0.5; caption("");
    if (seq.t > DIVE_T) go("timeline");
  } else if (p === "timeline" || p === "tour") {
    const s = focus;
    orbitPos(s.group.position, s.outer * 2.75, seq.theta * 2.5, 0.92, camGoal); frameNode(s);
    core.formTarget = 0.5;
    if (p === "timeline") {
      // rewind the system to day one, then replay it
      caption(CAP.timeline);
      s.reveal = seq.t < 1.2 ? 1 - seq.t / 1.2 : Math.min(1, (seq.t - 1.2) / 7);
      if (seq.t > 9.4) { go("tour"); seq.left = 4; seq.next = 0; }
    } else {
      caption(CAP.tour); seq.next -= dt;
      if (seq.next <= 0) { if (seq.left-- <= 0) { clearFocus(); go("back"); } else { select(pickInteresting(s)); seq.next = 3.6; } }
    }
  } else if (p === "back") {
    orbitPos(ORIGIN, WIDE_DIST, seq.theta, 1.05, camGoal); lookGoal.set(0, -WIDE_DIST * 0.05, 0); caption(CAP.galaxy);
    if (seq.t > 3) go("wide"), (seq.t = 6.5);
  }
}

// ---------- interaction (optional; the demo runs without it) ----------
let state = "demo", lastInput = -1e9, moved = false, drag = null, pinch0 = null;
const orbit = { theta: 0, phi: 1.1, dist: 1200 }, pointers = new Map();
function syncOrbit(c) { v.copy(camera.position).sub(c); orbit.dist = v.length(); orbit.theta = Math.atan2(v.z, v.x); orbit.phi = Math.acos(THREE.MathUtils.clamp(v.y / orbit.dist, -1, 1)); }
const clampDist = (d) => (focus ? THREE.MathUtils.clamp(d, focus.outer * 1.2, focus.outer * 5) : THREE.MathUtils.clamp(d, 350, WIDE_DIST * 1.4));
function wake() {
  lastInput = performance.now();
  if (state !== "demo") return;
  if (seq.g) endGrow();
  if (ui.compare.classList.contains("visible")) { ui.compare.classList.remove("visible"); systems.forEach((s) => (s.dimTarget = focus ? (s === focus ? 1 : DIM) : 1)); core.dimTarget = focus ? DIM : 1; }
  caption(""); state = focus ? "system" : "galaxy";
  syncOrbit(focus ? focus.group.position : ORIGIN);
  ui.back.classList.toggle("visible", !!focus);
}
function enter(s) { setFocus(s); s.reveal = 0; state = "system"; syncOrbit(s.group.position); orbit.dist = s.outer * 2.75; orbit.phi = 0.92; ui.back.classList.add("visible"); }
function toGalaxy() { clearFocus(); state = "galaxy"; syncOrbit(ORIGIN); orbit.dist = WIDE_DIST; orbit.phi = 1.05; ui.back.classList.remove("visible"); }
function tap(x, y) {
  let best = null, bd;
  if (state === "galaxy") {
    bd = 80; for (const s of systems) { toScreen(s.group, sp); const d = Math.hypot(sp.x - x, sp.y - y); if (sp.ok && d < bd) { bd = d; best = s; } }
    if (best) enter(best);
  } else if (state === "system") {
    bd = 44; for (const b of focus.bodies) { if (b.ratio > focus.reveal) continue; toScreen(b.mesh, sp); const d = Math.hypot(sp.x - x, sp.y - y); if (sp.ok && d < bd) { bd = d; best = b; } }
    select(best);
  }
}
canvas.addEventListener("pointerdown", (e) => { pointers.set(e.pointerId, e); drag = { x: e.clientX, y: e.clientY }; moved = false; wake(); });
addEventListener("pointermove", (e) => {
  if (scrubbing) return scrubTo(e.clientX);
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, e); lastInput = performance.now();
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!pinch0) pinch0 = { d, dist: orbit.dist };
    orbit.dist = clampDist((pinch0.dist * pinch0.d) / d); moved = true; return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
  drag = { x: e.clientX, y: e.clientY };
  orbit.theta += dx * 0.005; orbit.phi = THREE.MathUtils.clamp(orbit.phi - dy * 0.004, 0.25, 2.6);
});
addEventListener("pointerup", (e) => {
  const was = pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch0 = null;
  if (scrubbing) { scrubbing = false; return; }
  if (was && !moved) tap(e.clientX, e.clientY);
});
canvas.addEventListener("wheel", (e) => { wake(); orbit.dist = clampDist(orbit.dist * (1 + e.deltaY * 0.001)); }, { passive: true });
ui.back.addEventListener("click", () => { wake(); toGalaxy(); });

// ---------- main loop ----------
let lastTs = null, tAcc = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (ts === undefined) ts = performance.now();
  const dt = lastTs === null ? 1 / 60 : Math.min(0.05, Math.max(0, (ts - lastTs) / 1000)); lastTs = ts;
  tAcc += dt; const t = tAcc; // time from the vsync timestamp, so motion steps evenly
  if (state !== "demo" && !window.__tourPaused && performance.now() - lastInput > IDLE_MS) { clearFocus(); state = "demo"; ui.back.classList.remove("visible"); go("wide"); }
  updateSystems(dt, t);
  if (state === "demo" && !systems.length) { wideCam(t); rig(dt, 1.1); }
  else if (state === "demo") { updateDemo(dt, t); rig(dt, seq.phase === "dive" ? 7 : 1.1); }
  else {
    const c = focus ? focus.group.position : ORIGIN;
    orbit.dist = clampDist(orbit.dist); orbitPos(c, orbit.dist, orbit.theta, orbit.phi, camGoal);
    if (focus) frameNode(focus); else lookGoal.copy(ORIGIN);
    core.formTarget = focus ? 0.5 : 0.85;
    if (focus && !scrubbing && focus.reveal < 1) focus.reveal = Math.min(1, focus.reveal + dt * 0.12);
    rig(dt, 4);
  }
  updateCore(dt, t);
  updateEdges(t);
  if (focus) setScrub(focus.reveal);
  const blurGoal = focus ? BLUR : state === "demo" && seq.phase === "compare" ? 3.2 : 0;
  setBlur(blurAmt + (blurGoal - blurAmt) * Math.min(1, dt * 2.5));
  updateFlares(dt);
  film.uniforms.time.value = t;
  updateLabels();
  composer.render();
}

// ---------- build / rebuild the galaxy from a list of journeys ----------
function disposeSystems() {
  for (const s of systems) {
    s.group.traverse((o) => { o.geometry?.dispose(); if (o.material && o.material !== dotMat) o.material.dispose(); });
    scene.remove(s.group); s.label.remove();
  }
  systems.length = 0;
  for (let i = deco.children.length - 1; i >= 0; i--) { const o = deco.children[i]; o.geometry?.dispose(); o.material?.dispose(); deco.remove(o); }
  clouds.length = 0;
  if (motes) { motes.geometry.dispose(); motes.material.dispose(); scene.remove(motes); motes = null; }
}
function buildGalaxy(journeys) {
  clearFocus(); if (seq.g) endGrow(); ui.compare.classList.remove("visible");
  disposeSystems();
  const profiles = assignLooks(journeys.filter((j) => j.graph && j.graph.nodes && j.graph.nodes.some((n) => n.timestamp)));
  [...profiles].sort((a, b) => a.graph.nodes.length - b.graph.nodes.length).forEach((p, r) => (p.orbitRank = r));
  profiles.forEach((p, i) => buildSystem(p, i, profiles.length));
  if (systems.length) layoutSystems();
  const solo = systems.length === 1;
  BEATS = solo ? ["sys", "core", "sys", "grow"] : ["sys", "sys", "core", "sys", "compare", "sys", "sys", "grow"];
  CAP.galaxy = solo ? SOLO.galaxy : "Each system is one Hermes, shaped by what it has learned.";
  CAP.grow1 = solo ? SOLO.grow1 : "This is every journey growing at once, day by day.";
  state = "demo"; seq.beat = 0; seq.idx = -1; go(systems.length ? "grow" : "wide");
  document.body.classList.toggle("empty", !systems.length);
  return systems.length;
}

(async () => {
  await document.fonts.ready;
  await buildCore();
  // hide the cursor after 3 s without movement (nice on TVs)
  let curT; const curHide = () => { document.body.style.cursor = ""; clearTimeout(curT); curT = setTimeout(() => (document.body.style.cursor = "none"), 3000); };
  addEventListener("pointermove", curHide); curHide();
  frame();
  const journeys = await loadJourneys();
  buildGalaxy(journeys);
  setupPanel({ rebuild: buildGalaxy, systems: () => systems, pauseTour: (on) => { window.__tourPaused = on; if (on) wake(); }, focusSystem: (name) => { const s = systems.find((x) => x.name === name); if (s) { wake(); enter(s); } } });
  window.__qa = { systems, camera, footprint, THREE, deco, film, bloom, composer, renderer };
  window.__debug = () => ({ state, phase: seq.phase, focus: focus && focus.name, selected: selected && selected.node.label, reveal: focus && +focus.reveal.toFixed(2), systems: systems.length });
  window.__tour = (i) => { state = "demo"; if (seq.g) endGrow(); seq.idx = i; setFocus(systems[i]); focus.reveal = 1; go("dive"); };
  window.__phase = (p) => { state = "demo"; if (seq.g && p !== "grow") endGrow(); if (p !== "dive" && p !== "timeline" && p !== "tour") clearFocus(); go(p); };
  window.__skip = (sec) => { seq.t += sec; };
})();
