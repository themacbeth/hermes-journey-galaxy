// Procedural canvas textures (no external assets)
import * as THREE from "./vendor/three.module.min.js";

export function glowTexture(hardness = 0.3) {
  const s = 256, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d"), grad = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(hardness, "rgba(150,180,255,0.35)");
  grad.addColorStop(1, "rgba(10,20,60,0)");
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

function rgb(c, a = 1) { return `rgba(${c.r*255|0},${c.g*255|0},${c.b*255|0},${a})`; }

// Mottled stellar surface
export function sunTexture(hex) {
  const s = 256, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d"), base = new THREE.Color(hex);
  g.fillStyle = rgb(base); g.fillRect(0, 0, s, s);
  for (let i = 0; i < 220; i++) {
    const k = base.clone().offsetHSL(0, 0, (Math.random() - 0.45) * 0.4);
    g.fillStyle = rgb(k, 0.1 + Math.random() * 0.2);
    g.beginPath();
    const r = 4 + Math.random() * 24;
    g.ellipse(Math.random()*s, Math.random()*s, r, r*(0.4+Math.random()*0.6), Math.random()*3.14, 0, 6.29);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Skills: banded gas giants. Memories: speckled ice moons.
export function planetTexture(hex, isMemory) {
  const s = 256, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d"), base = new THREE.Color(hex);
  g.fillStyle = rgb(base); g.fillRect(0, 0, s, s);
  if (isMemory) {
    for (let i = 0; i < 110; i++) {
      g.fillStyle = rgb(base.clone().offsetHSL(0, 0, (Math.random()-0.5)*0.4), 0.3+Math.random()*0.5);
      g.beginPath(); g.arc(Math.random()*s, Math.random()*s, 1+Math.random()*4, 0, 6.29); g.fill();
    }
  } else {
    let y = 0;
    while (y < s) {
      const h = 4 + Math.random() * 18;
      g.fillStyle = rgb(base.clone().offsetHSL(0, 0, (Math.random()-0.5)*0.3), 0.6);
      g.fillRect(0, y, s, h);
      y += h;
    }
    for (let i = 0; i < 14; i++) {        // storms
      g.fillStyle = rgb(base.clone().offsetHSL(0, 0, 0.25), 0.25);
      g.beginPath(); g.ellipse(Math.random()*s, Math.random()*s, 3+Math.random()*7, 1.5+Math.random()*2, 0, 0, 6.29); g.fill();
    }
  }
  return new THREE.CanvasTexture(c);
}
