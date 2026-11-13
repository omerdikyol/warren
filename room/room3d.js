/* warren — the agents' room.
 *
 * A low-poly studio built with three.js. One desk per coding agent, the agent
 * an animal at it. Everything is generated from primitives at load time: no
 * model files, no textures on disk, no CDN.
 *
 * Staging, because it decides the look. The camera lives on the +Z side. An
 * animal faces the camera, so it sits on the -Z side of its desk and its
 * monitor stands between the two showing us the *back* — you never see a
 * screen, only the light it throws on the animal and the desk. That glow is the
 * main cue that a desk is busy.
 *
 * Text is not drawn in the 3D scene: canvas textures look soft at any zoom, so
 * each desk gets an HTML card positioned by projecting its world position every
 * frame. Crisp type, and CSS does the styling.
 *
 * Camera: drag to orbit, right-drag or shift-drag to pan, wheel or pinch to
 * zoom, arrows and +/- on the keyboard, R or the HUD button to fit the room.
 * It auto-fits as desks are added, until you take over.
 */
import * as THREE from "./vendor/three.module.js";

const MOODS = {
  day: { skyTop: "#8fd0ff", skyMid: "#dcefff", skyLow: "#ffeada", sun: "#fff4dc", sunPower: 1.8, hemi: 0.78, ambient: "#ffffff" },
  evening: { skyTop: "#6f9ed4", skyMid: "#ffd2ab", skyLow: "#ffb49a", sun: "#ffc98f", sunPower: 1.25, hemi: 0.7, ambient: "#ffe6d2" },
  night: { skyTop: "#26365c", skyMid: "#3d4a70", skyLow: "#6b5a72", sun: "#b3c4e6", sunPower: 0.8, hemi: 0.66, ambient: "#ffe9cf" },
};
function moodFor(hour) {
  if (hour >= 7 && hour < 18) return MOODS.day;
  if (hour >= 18 && hour < 22) return MOODS.evening;
  return MOODS.night;
}

const SPECIES = {
  claude:   { fur: "#f7c9a8", belly: "#fff1e2", ear: "pointy", earIn: "#f2a68c", tail: "curl",    nose: "#e08a76" },
  codex:    { fur: "#ef854a", belly: "#fff3e6", ear: "pointy", earIn: "#d4712c", tail: "bushy",   nose: "#7a4a38" },
  omp:      { fur: "#a9754c", belly: "#f6e6d6", ear: "round",  earIn: "#8d5c37", tail: "thick",   nose: "#5f3a1f" },
  opencode: { fur: "#8fa9c9", belly: "#eef4fb", ear: "tuft",   earIn: "#6f8bab", tail: "feather", nose: "#eda452", beak: true },
  cmd:      { fur: "#69707c", belly: "#eef1f5", ear: "round",  earIn: "#4a5059", tail: "striped", nose: "#2b2f36" },
  agy:      { fur: "#3c5c8f", belly: "#ffffff", ear: "round",  earIn: "#2c4569", tail: "tiny",    nose: "#f0b429", beak: true },
  freebuff: { fur: "#ffc255", belly: "#fff6e2", ear: "round",  earIn: "#dd9c33", tail: "bushy",   nose: "#c98f6b" },
  aider:    { fur: "#c2a0ec", belly: "#f8f2ff", ear: "pointy", earIn: "#a17dce", tail: "curl",    nose: "#8a60bb" },
  hamster:  { fur: "#f0d69c", belly: "#fff6e0", ear: "round",  earIn: "#dfba78", tail: "tiny",    nose: "#c98f6b" },
};

const SIT_Y = 0.86;
const DESK_W = 2.6, DESK_D = 1.38, DESK_TOP = 1.34;

const matCache = new Map();
const mat = (color, opts = {}) => {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts }));
  return matCache.get(key);
};
const box = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
const sph = (r, m, s = 9) => new THREE.Mesh(new THREE.SphereGeometry(r, s, Math.max(6, s - 2)), m);
const cyl = (rt, rb, h, m, s = 12) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, s), m);
const cone = (r, h, m, s = 6) => new THREE.Mesh(new THREE.ConeGeometry(r, h, s), m);
const plane = (w, h, m) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
const at = (mesh, x, y, z) => { mesh.position.set(x, y, z); return mesh; };
const shade = (n) => { n.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); return n; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let seed = 4;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

function skyTexture(m) {
  const c = document.createElement("canvas");
  c.width = 8; c.height = 256;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, m.skyTop); g.addColorStop(0.62, m.skyMid); g.addColorStop(1, m.skyLow);
  x.fillStyle = g; x.fillRect(0, 0, 8, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function plankTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d");
  x.fillStyle = "#e6d3b4"; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 8; i += 1) {
    const y = i * 32;
    x.fillStyle = i % 2 ? "rgba(255,255,255,0.06)" : "rgba(96,64,32,0.05)";
    x.fillRect(0, y, 256, 32);
    for (let k = 0; k < 5; k += 1) {
      x.fillStyle = "rgba(140,105,70,0.10)";
      x.fillRect(rnd() * 256, y + rnd() * 28, 40 + rnd() * 70, 1.3);
    }
    x.fillStyle = "rgba(122,90,58,0.22)";
    x.fillRect(0, y + 30, 256, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
}

function makeCritter(species) {
  const s = SPECIES[species] || SPECIES.hamster;
  const g = new THREE.Group();
  const fur = mat(s.fur), belly = mat(s.belly), ink = mat("#3a3128");
  const blush = mat("#f59a92", { transparent: true, opacity: 0.55 });

  const body = sph(0.6, fur, 10);
  body.scale.set(1, 1.1, 0.88);
  body.position.y = 0.66;
  const front = sph(0.42, belly, 10);
  front.scale.set(0.92, 0.98, 0.5);
  front.position.set(0, 0.64, 0.33);
  g.add(body, front);

  const head = new THREE.Group();
  head.position.y = 1.46;
  g.add(head);
  const skull = sph(0.49, fur, 10);
  skull.scale.set(1, 0.96, 0.94);
  const snout = at(sph(0.19, belly, 9), 0, -0.12, 0.43);
  snout.scale.set(1.05, 0.78, 0.9);
  head.add(skull, snout);
  head.add(at(sph(0.07, mat(s.nose), 7), 0, -0.055, 0.58));

  const eyesOpen = new THREE.Group();
  const eyesShut = new THREE.Group();
  for (const side of [-1, 1]) {
    eyesOpen.add(at(sph(0.082, ink, 8), 0.185 * side, 0.075, 0.4));
    eyesOpen.add(at(sph(0.03, mat("#ffffff"), 6), 0.205 * side, 0.115, 0.45));
    eyesShut.add(at(box(0.24, 0.05, 0.03, mat("#5a4a3c")), 0.185 * side, 0.07, 0.45));
    const cheek = at(sph(0.082, blush, 7), 0.33 * side, -0.07, 0.33);
    cheek.scale.set(1, 0.66, 0.4);
    head.add(cheek);
  }
  head.add(eyesOpen, eyesShut);
  eyesShut.visible = false;

  for (const side of [-1, 1]) {
    if (s.ear === "pointy") {
      const outer = at(cone(0.2, 0.42, fur, 4), 0.26 * side, 0.42, 0);
      outer.rotation.z = -0.22 * side;
      const inner = at(cone(0.1, 0.24, mat(s.earIn), 4), 0.26 * side, 0.42, 0.05);
      inner.rotation.z = -0.22 * side;
      head.add(outer, inner);
    } else if (s.ear === "tuft") {
      const tuft = at(cone(0.12, 0.3, fur, 4), 0.29 * side, 0.44, 0);
      tuft.rotation.z = -0.5 * side;
      head.add(tuft);
    } else {
      const outer = at(sph(0.165, fur, 9), 0.35 * side, 0.33, 0);
      outer.scale.set(1, 1, 0.5);
      const inner = at(sph(0.085, mat(s.earIn), 8), 0.35 * side, 0.33, 0.07);
      inner.scale.set(1, 1, 0.4);
      head.add(outer, inner);
    }
  }
  if (s.beak) {
    const beak = at(cone(0.1, 0.24, mat(s.nose), 4), 0, -0.13, 0.55);
    beak.rotation.x = Math.PI / 2;
    head.add(beak);
  }

  const arms = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(0.38 * side, 0.92, 0.2);
    const limb = at(sph(0.15, fur, 8), 0, -0.2, 0);
    limb.scale.set(0.8, 1.5, 0.8);
    arm.add(limb, at(sph(0.14, belly, 8), 0.04 * side, -0.42, 0.06));
    g.add(arm);
    arms.push(arm);
  }

  const tail = new THREE.Group();
  tail.position.set(0, 0.48, -0.46);
  if (s.tail === "bushy" || s.tail === "thick") {
    const t = at(sph(0.25, fur, 9), 0, 0.14, -0.3);
    t.scale.set(0.9, 0.9, 1.45);
    tail.add(t, at(sph(0.15, mat(s.belly), 8), 0, 0.19, -0.68));
  } else if (s.tail === "striped") {
    for (let i = 0; i < 4; i += 1) tail.add(at(sph(0.155 - i * 0.02, mat(i % 2 ? "#3d434c" : s.fur), 8), 0, 0.09 + i * 0.13, -0.32 - i * 0.1));
  } else if (s.tail === "feather") {
    for (const side of [-1, 1]) {
      const f = at(cone(0.11, 0.48, fur, 4), 0.13 * side, 0, -0.3);
      f.rotation.x = Math.PI / 2.4;
      f.rotation.z = 0.2 * side;
      tail.add(f);
    }
  } else if (s.tail === "curl") {
    const t = at(cyl(0.085, 0.085, 0.62, fur, 8), 0, 0.26, -0.32);
    t.rotation.x = 1.0;
    tail.add(t);
  } else {
    tail.add(at(sph(0.15, fur, 8), 0, 0.09, -0.4));
  }
  g.add(tail);
  g.add(at(cyl(0.45, 0.45, 0.15, mat("#ef7f6a"), 12), 0, 1.05, 0));

  shade(g);
  return { group: g, head, eyesOpen, eyesShut, arms, tail, state: "idle", blink: rnd() * 5, phase: rnd() * 6.28 };
}

function makeDesk(species) {
  const g = new THREE.Group();
  const wood = mat("#d8a468"), woodDark = mat("#a8763f"), metal = mat("#cfc9bf");

  const top = box(DESK_W, 0.14, DESK_D, wood);
  top.position.y = DESK_TOP - 0.07;
  g.add(top);
  for (const [sx, sz] of [[-1.14, -0.54], [1.14, -0.54], [-1.14, 0.54], [1.14, 0.54]]) {
    g.add(at(box(0.13, 1.2, 0.13, woodDark), sx, 0.66, sz));
  }
  g.add(at(box(2.3, 0.1, 0.1, woodDark), 0, 0.38, -0.54));

  const monitor = new THREE.Group();
  monitor.position.set(0, DESK_TOP, -0.36);
  const shell = at(box(1.22, 0.74, 0.06, mat("#e9e4da")), 0, 0.72, 0);
  const back = at(box(1.1, 0.62, 0.03, mat("#ddd7cc")), 0, 0.72, 0.045);
  const vent = at(box(0.42, 0.03, 0.02, mat("#bcb5a9")), 0, 0.52, 0.062);
  const logo = at(cyl(0.045, 0.045, 0.02, mat("#bcb5a9"), 10), 0, 0.86, 0.062);
  logo.rotation.x = Math.PI / 2;
  const rim = box(1.26, 0.78, 0.02, new THREE.MeshBasicMaterial({ color: "#ffcf8a", transparent: true, opacity: 0 }));
  rim.position.set(0, 0.72, -0.02);
  const led = at(sph(0.035, new THREE.MeshBasicMaterial({ color: "#c9c2b6" }), 8), 0.52, 0.62, 0.075);
  monitor.add(at(box(0.52, 0.05, 0.3, metal), 0, 0, 0), at(box(0.09, 0.34, 0.09, metal), 0, 0.19, 0), shell, back, vent, logo, rim, led);
  g.add(monitor);

  const glow = new THREE.PointLight("#ffcb84", 0, 4.8, 2);
  glow.position.set(0, 1.9, -0.58);
  g.add(glow);
  const pool = plane(1.6, 0.85, new THREE.MeshBasicMaterial({ color: "#ffd9a0", transparent: true, opacity: 0 }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0, DESK_TOP + 0.012, -0.98);
  g.add(pool);

  g.add(at(box(1.06, 0.035, 0.3, mat("#eceae4")), 0, DESK_TOP + 0.018, 0.12));
  const mouse = at(sph(0.075, mat("#e6e2da"), 9), 0.72, DESK_TOP + 0.03, 0.12);
  mouse.scale.set(1, 0.6, 1.35);
  g.add(mouse);

  const mug = new THREE.Group();
  mug.position.set(1.03, DESK_TOP, -0.12);
  mug.add(at(cyl(0.1, 0.085, 0.19, mat("#f2ede2"), 12), 0, 0.095, 0));
  const handle = at(cyl(0.055, 0.055, 0.02, mat("#f2ede2"), 8), 0.11, 0.095, 0);
  handle.rotation.z = Math.PI / 2;
  mug.add(handle);
  g.add(mug);

  const steam = new THREE.Group();
  steam.position.set(1.03, DESK_TOP + 0.22, -0.12);
  for (let i = 0; i < 3; i += 1) {
    steam.add(at(sph(0.035, new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.26 }), 7), (i - 1) * 0.05, i * 0.06, 0));
  }
  g.add(steam);

  const plant = new THREE.Group();
  plant.position.set(-1.0, DESK_TOP, -0.14);
  plant.add(at(cyl(0.13, 0.1, 0.19, mat("#d97f5c"), 12), 0, 0.095, 0));
  const leaves = [];
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2;
    const leaf = at(cone(0.06, 0.3, mat(i % 2 ? "#7cbc7f" : "#5f9c63"), 4), Math.cos(a) * 0.06, 0.28, Math.sin(a) * 0.06);
    leaf.rotation.z = Math.cos(a) * 0.42;
    leaf.rotation.x = -Math.sin(a) * 0.42;
    plant.add(leaf);
    leaves.push(leaf);
  }
  g.add(plant);

  const pad = at(box(0.44, 0.02, 0.34, mat("#f4efe4")), 0.68, DESK_TOP + 0.012, -0.44);
  pad.rotation.y = 0.18;
  const pen = at(cyl(0.02, 0.02, 0.22, mat("#c9694a"), 6), 0.86, DESK_TOP + 0.03, -0.4);
  pen.rotation.z = Math.PI / 2;
  pen.rotation.y = 0.3;
  g.add(pad, pen);

  const chair = new THREE.Group();
  chair.position.set(0, 0, -1.52);
  chair.add(at(box(0.86, 0.13, 0.82, mat("#8fc9bb")), 0, 0.72, 0));
  chair.add(at(box(0.86, 0.9, 0.13, mat("#7fb8aa")), 0, 1.16, -0.34));
  for (const [sx, sz] of [[-0.34, -0.32], [0.34, -0.32], [-0.34, 0.32], [0.34, 0.32]]) {
    chair.add(at(box(0.08, 0.7, 0.08, woodDark), sx, 0.35, sz));
  }
  shade(chair);
  g.add(chair);

  const creature = makeCritter(species);
  creature.group.position.set(0, SIT_Y, -0.96);
  creature.group.scale.setScalar(1.06);
  g.add(creature.group);

  const carton = new THREE.Group();
  carton.position.set(0, DESK_TOP, -0.2);
  carton.add(at(box(1.0, 0.68, 0.78, mat("#d9a86a")), 0, 0.34, 0));
  carton.add(at(box(0.16, 0.7, 0.8, mat("#f0e2c6")), 0, 0.34, 0));
  carton.add(at(box(1.06, 0.09, 0.84, mat("#c08f52")), 0, 0.7, 0));
  carton.visible = false;
  shade(carton);
  g.add(carton);

  shade(g);
  return { group: g, creature, glow, pool, rim, steam, mug, leaves, monitor, carton, chair, led };
}

function buildRoom(scene, mood) {
  const life = { leaves: [], bulbs: [], clouds: [] };

  const floor = box(27, 0.5, 23, new THREE.MeshLambertMaterial({ map: plankTexture() }));
  floor.position.y = -0.25;
  floor.receiveShadow = true;
  scene.add(floor);
  scene.add(at(box(27.3, 0.2, 23.3, mat("#d9c6a8")), 0, -0.52, 0));

  for (const [rx, rz, r, col] of [[-8.4, 9.4, 3.2, "#bfe4d4"]]) {
    const rug = cyl(r, r, 0.05, mat(col), 28);
    rug.position.set(rx, 0.03, rz);
    rug.receiveShadow = true;
    const edge = cyl(r + 0.14, r + 0.14, 0.04, mat("#a8cfc0"), 28);
    edge.position.set(rx, 0.01, rz);
    edge.receiveShadow = true;
    scene.add(rug, edge);
  }

  scene.add(at(box(27, 12, 0.5, mat("#fdf4ea")), 0, 5.5, -11.5));
  scene.add(at(box(0.5, 12, 23, mat("#f8efe4")), -13.5, 5.5, 0));
  scene.add(at(box(27, 0.55, 0.6, mat("#efe3d3")), 0, 0.27, -11.25));
  scene.add(at(box(0.6, 0.55, 23, mat("#efe3d3")), -13.25, 0.27, 0));

  scene.add(at(box(6.6, 4.8, 0.24, mat("#fdf8f0")), 3.9, 6.4, -11.2));
  scene.add(at(plane(6.0, 4.2, new THREE.MeshBasicMaterial({ color: "#e6f4ff", transparent: true, opacity: 0.16 })), 3.9, 6.4, -11.05));
  scene.add(at(box(0.13, 4.2, 0.16, mat("#fdf8f0")), 3.9, 6.4, -11.04));
  scene.add(at(box(6.0, 0.13, 0.16, mat("#fdf8f0")), 3.9, 6.4, -11.04));
  for (let i = 0; i < 5; i += 1) {
    const cloud = new THREE.Group();
    for (let k = 0; k < 3; k += 1) {
      cloud.add(at(sph(0.5 + rnd() * 0.3, new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.85 }), 8), k * 0.6 - 0.6, rnd() * 0.2, 0));
    }
    cloud.position.set(-15 + rnd() * 28, 5.0 + rnd() * 3.4, -13.5);
    cloud.scale.setScalar(0.8 + rnd() * 0.5);
    scene.add(cloud);
    life.clouds.push(cloud);
  }

  scene.add(at(box(4.8, 0.18, 1.0, mat("#d8a468")), -8.6, 5.1, -11.1));
  for (let i = 0; i < 10; i += 1) {
    scene.add(at(box(0.16 + (i % 3) * 0.04, 0.62 - (i % 2) * 0.09, 0.46, mat(["#ef7f6a", "#7fb0e0", "#8fcb96", "#f0c46a", "#c1a3e6"][i % 5])), -10.4 + i * 0.44, 5.5, -11.08));
  }
  scene.add(at(box(2.0, 1.5, 0.12, mat("#fdf8f0")), -5.6, 6.6, -11.22));
  scene.add(at(box(1.64, 1.14, 0.08, mat("#a8d8f5")), -5.6, 6.6, -11.14));
  const artSun = at(cyl(0.17, 0.17, 0.08, mat("#ffd79a"), 12), -5.2, 6.9, -11.1);
  artSun.rotation.x = Math.PI / 2;
  const artHill = at(cone(0.56, 0.5, mat("#9ccb95"), 5), -6.1, 6.2, -11.1);
  artHill.rotation.x = Math.PI / 2;
  scene.add(artSun, artHill);

  scene.add(at(box(5.2, 2.7, 0.14, mat("#fbfaf6")), 10.0, 5.3, -11.2));
  scene.add(at(box(5.4, 0.15, 0.18, mat("#cfc9bf")), 10.0, 3.9, -11.15));
  for (let i = 0; i < 5; i += 1) {
    scene.add(at(box(1.6 - i * 0.22, 0.09, 0.05, mat(["#ef7f6a", "#7fb0e0", "#8fcb96", "#f0c46a", "#c1a3e6"][i])), 8.6 + i * 0.55, 6.0 - i * 0.4, -11.12));
  }

  const face = at(cyl(0.66, 0.66, 0.1, mat("#fdf8f0"), 22), -0.6, 7.0, -11.2);
  face.rotation.x = Math.PI / 2;
  const hub = at(cyl(0.07, 0.07, 0.1, mat("#c9694a"), 10), -0.6, 7.0, -11.12);
  hub.rotation.x = Math.PI / 2;
  const hourHand = new THREE.Group();
  hourHand.position.set(-0.6, 7.0, -11.11);
  hourHand.add(at(box(0.075, 0.36, 0.05, mat("#6b5745")), 0, 0.18, 0));
  const minuteHand = new THREE.Group();
  minuteHand.position.set(-0.6, 7.0, -11.12);
  minuteHand.add(at(box(0.055, 0.52, 0.04, mat("#8a7566")), 0, 0.26, 0));
  scene.add(face, hub, hourHand, minuteHand);

  for (let i = 0; i < 22; i += 1) {
    const bulb = at(sph(0.085, new THREE.MeshBasicMaterial({ color: i % 3 ? "#ffdca6" : "#ffb3c8" }), 8), -13 + i * 1.25, 9.2 + Math.sin(i * 1.1) * 0.28, -11.2);
    scene.add(bulb);
    life.bulbs.push(bulb);
  }

  const bigPlant = (px, pz, scale) => {
    const g = new THREE.Group();
    g.position.set(px, 0, pz);
    g.scale.setScalar(scale);
    g.add(at(cyl(0.62, 0.48, 0.9, mat("#d97f5c"), 14), 0, 0.45, 0));
    for (let i = 0; i < 9; i += 1) {
      const a = (i / 9) * Math.PI * 2;
      const leaf = at(cone(0.22, 1.7, mat(i % 2 ? "#7cbc7f" : "#5f9c63"), 5), Math.cos(a) * 0.22, 1.6 + (i % 3) * 0.2, Math.sin(a) * 0.22);
      leaf.rotation.z = Math.cos(a) * 0.42;
      leaf.rotation.x = -Math.sin(a) * 0.42;
      g.add(leaf);
      life.leaves.push({ node: leaf, base: leaf.rotation.z, phase: rnd() * 6.28 });
    }
    shade(g);
    scene.add(g);
  };
  bigPlant(-12.0, -6.4, 1.0);
  bigPlant(-12.2, 8.6, 0.85);

  const pole = at(cyl(0.07, 0.07, 3.6, mat("#8a8378"), 10), -11.6, 1.8, 9.4);
  const shadeCone = at(cone(0.78, 0.95, mat("#ffe3b0"), 14), -11.6, 3.5, 9.4);
  const lampGlow = new THREE.PointLight("#ffd9a0", 0.5, 12, 2);
  lampGlow.position.set(-11.6, 3.2, 9.4);
  scene.add(pole, shadeCone, lampGlow);

  scene.add(at(cyl(1.1, 1.1, 0.14, mat("#d8a468"), 18), -11.7, 0.92, 3.0));
  scene.add(at(cyl(0.3, 0.4, 0.92, mat("#a8763f"), 14), -11.7, 0.46, 3.0));
  scene.add(at(cyl(0.32, 0.2, 0.18, mat("#8fcb96"), 14), -11.7, 1.06, 3.0));
  for (let i = 0; i < 3; i += 1) {
    scene.add(at(sph(0.13, mat(["#ef7f6a", "#f0c46a", "#8fcb96"][i]), 9), -11.7 + (i - 1) * 0.16, 1.2, 3.0 + (i % 2) * 0.1));
  }
  for (const [cx, cz, col] of [[-6.6, 10.6, "#f2c9a8"], [6.0, 10.9, "#a8d8c0"]]) {
    const cushion = at(sph(0.9, mat(col), 16), cx, 0.34, cz);
    cushion.scale.set(1, 0.4, 1);
    scene.add(cushion);
  }
  for (let i = 0; i < 2; i += 1) {
    const boxp = at(box(1.3, 0.9, 1.0, mat("#d9a86a")), -12.5 + i * 1.4, 0.45, 9.4 - i * 0.3);
    boxp.rotation.y = i * 0.3;
    shade(boxp);
    scene.add(boxp);
  }

  return { life, hourHand, minuteHand };
}

function makeCat() {
  const g = new THREE.Group();
  const fur = mat("#6b6f78"), belly = mat("#e8eaf0");
  const body = at(sph(0.42, fur, 10), 0, 0.42, 0);
  body.scale.set(1.5, 0.9, 0.9);
  g.add(body);
  const head = new THREE.Group();
  head.position.set(0.62, 0.6, 0);
  head.add(sph(0.3, fur, 10));
  for (const side of [-1, 1]) head.add(at(cone(0.12, 0.26, fur, 4), -0.05, 0.24, 0.16 * side));
  head.add(at(sph(0.05, mat("#3a3128"), 7), 0.24, 0.06, 0.14));
  head.add(at(sph(0.05, mat("#3a3128"), 7), 0.24, 0.06, -0.14));
  head.add(at(sph(0.12, belly, 8), 0.26, -0.06, 0));
  g.add(head);
  const tail = new THREE.Group();
  tail.position.set(-0.6, 0.52, 0);
  const t = at(cyl(0.05, 0.04, 0.7, fur, 8), -0.16, 0.2, 0);
  t.rotation.z = 0.9;
  tail.add(t);
  g.add(tail);
  for (const [lx, lz] of [[0.3, 0.16], [0.3, -0.16], [-0.3, 0.16], [-0.3, -0.16]]) {
    g.add(at(box(0.11, 0.34, 0.11, fur), lx, 0.17, lz));
  }
  shade(g);
  return { group: g, head, tail };
}

let currentRenderer = null;
export function captureDataURL() {
  return currentRenderer ? currentRenderer.domElement.toDataURL("image/png") : "";
}

export function mountRoom3D(container) {
  const forcedMood = new URLSearchParams(location.search).get("mood");
  const mood = forcedMood && MOODS[forcedMood] ? MOODS[forcedMood] : moodFor(new Date().getHours());
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: /[?&]shot=1/.test(location.search) });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  Object.assign(renderer.domElement.style, { display: "block", width: "100%", height: "100%", touchAction: "none", cursor: "grab" });
  currentRenderer = renderer;

  const stage = document.createElement("div");
  stage.className = "room-stage";
  stage.append(renderer.domElement);

  const overlay = document.createElement("div");
  overlay.className = "room-tags";

  const hud = document.createElement("div");
  hud.className = "room-hud";
  hud.innerHTML = '<button data-act="in" title="zoom in">+</button>'
    + '<button data-act="out" title="zoom out">−</button>'
    + '<button data-act="reset" title="fit the room">⌂</button>'
    + '<span class="room-hint">drag to look · right-drag to pan · scroll to zoom</span>';

  const card = document.createElement("div");
  card.className = "room-card";
  card.hidden = true;

  const note = document.createElement("div");
  note.className = "room-note";
  note.hidden = true;
  note.textContent = "No agents running — showing their last known state";

  const empty = document.createElement("div");
  empty.className = "room-empty";
  empty.hidden = true;
  empty.innerHTML = '<b>The room is quiet.</b><span>No agent sessions. Start one with <code>dev.sh session &lt;name&gt;</code>.</span>';

  container.replaceChildren(stage, overlay, hud, card, note, empty);

  const scene = new THREE.Scene();
  scene.background = skyTexture(mood);
  scene.fog = new THREE.Fog(new THREE.Color(mood.skyMid), 48, 108);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 280);

  scene.add(new THREE.HemisphereLight(new THREE.Color(mood.ambient).lerp(new THREE.Color("#ffffff"), 0.35), new THREE.Color("#d8c9b4"), mood.hemi));
  const sun = new THREE.DirectionalLight(mood.sun, mood.sunPower);
  sun.position.set(11, 16, 9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 22, bottom: -16, far: 70 });
  sun.shadow.bias = -0.0011;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  const fill = new THREE.DirectionalLight("#cfe0ff", 0.3);
  fill.position.set(-10, 8, -9);
  scene.add(fill);

  const room = buildRoom(scene, mood);

  const DUST = 90;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(DUST * 3);
  const dustSeed = new Float32Array(DUST);
  for (let i = 0; i < DUST; i += 1) {
    dustPos[i * 3] = -2 + rnd() * 14;
    dustPos[i * 3 + 1] = 0.4 + rnd() * 8;
    dustPos[i * 3 + 2] = -10 + rnd() * 12;
    dustSeed[i] = rnd() * 6.28;
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: "#fff3d8", size: 0.07, transparent: true, opacity: 0.3, depthWrite: false })));

  const cat = makeCat();
  cat.group.position.set(-8, 0, 10.4);
  scene.add(cat.group);

  const desks = [];
  const pool = new Map();
  const group = new THREE.Group();
  scene.add(group);

  const cam = { yaw: 0.5, pitch: 0.5, dist: 32, tx: 0, tz: -2, cyaw: 0.5, cpitch: 0.5, cdist: 32, ctx: 0, ctz: -2 };
  let userMoved = false;
  let lastInput = performance.now();
  let lastFitted = -1;
  let gesture = null;

  function fitView() {
    if (!desks.length) { cam.tx = 0; cam.tz = -2; cam.dist = 32; return; }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const d of desks) {
      const p = d.parts.group.position;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    cam.tx = (minX + maxX) / 2;
    cam.tz = (minZ + maxZ) / 2 - 1.4;
    const half = Math.tan((camera.fov / 2) * Math.PI / 180);
    const needX = ((maxX - minX) + 9) / (2 * half * Math.max(camera.aspect, 0.6));
    const needZ = ((maxZ - minZ) + 10) / (2 * half);
    cam.dist = clamp(Math.max(needX, needZ) * 1.08, 17, 62);
  }

  const applyCam = () => {
    const y = Math.sin(cam.cpitch) * cam.cdist;
    const r = Math.cos(cam.cpitch) * cam.cdist;
    camera.position.set(cam.ctx + Math.sin(cam.cyaw) * r, 2.4 + y, cam.ctz + Math.cos(cam.cyaw) * r);
    camera.lookAt(cam.ctx, 2.4, cam.ctz);
  };

  const el = renderer.domElement;
  const pointers = new Map();
  let last = { x: 0, y: 0 }, pinch = 0;
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  function panBy(dx, dy) {
    const k = cam.dist * 0.0016;
    const rightX = Math.cos(cam.cyaw), rightZ = -Math.sin(cam.cyaw);
    const fwdX = Math.sin(cam.cyaw), fwdZ = Math.cos(cam.cyaw);
    cam.tx -= rightX * dx * k + fwdX * dy * k * 0.85;
    cam.tz -= rightZ * dx * k + fwdZ * dy * k * 0.85;
  }

  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    el.setPointerCapture(e.pointerId);
    lastInput = performance.now();
    userMoved = true;
    last = { x: e.clientX, y: e.clientY };
    gesture = pointers.size === 2 ? "pinch" : (e.button === 2 || e.shiftKey) ? "pan" : "orbit";
    if (gesture === "pinch") pinch = spread();
    el.style.cursor = gesture === "orbit" ? "grabbing" : "move";
  });
  el.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastInput = performance.now();
    if (gesture === "pinch" && pointers.size >= 2) {
      const d = spread();
      if (pinch > 0 && d > 0) cam.dist = clamp(cam.dist * (pinch / d), 12, 70);
      pinch = d;
      return;
    }
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    if (gesture === "pan") panBy(dx, dy);
    else {
      cam.yaw -= dx * 0.0055;
      cam.pitch = clamp(cam.pitch + dy * 0.0035, 0.1, 1.08);
    }
    last = { x: e.clientX, y: e.clientY };
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (!pointers.size) { gesture = null; el.style.cursor = "grab"; }
    lastInput = performance.now();
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    cam.dist = clamp(cam.dist * (1 + Math.sign(e.deltaY) * 0.09), 12, 70);
    lastInput = performance.now();
    userMoved = true;
  }, { passive: false });

  hud.addEventListener("click", (e) => {
    const act = e.target.dataset ? e.target.dataset.act : null;
    userMoved = true;
    if (act === "in") cam.dist = clamp(cam.dist * 0.85, 12, 70);
    if (act === "out") cam.dist = clamp(cam.dist * 1.18, 12, 70);
    if (act === "reset") { userMoved = false; fitView(); cam.yaw = 0.5; cam.pitch = 0.5; }
  });

  const onKey = (e) => {
    const step = e.shiftKey ? 0.16 : 0.07;
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "r", "R", "+", "=", "-", "_", "0"];
    if (!keys.includes(e.key)) return;
    userMoved = true;
    if (e.key === "ArrowLeft") cam.yaw -= step;
    if (e.key === "ArrowRight") cam.yaw += step;
    if (e.key === "ArrowUp") cam.pitch = clamp(cam.pitch + step * 0.5, 0.1, 1.08);
    if (e.key === "ArrowDown") cam.pitch = clamp(cam.pitch - step * 0.5, 0.1, 1.08);
    if (e.key === "+" || e.key === "=") cam.dist = clamp(cam.dist * 0.88, 12, 70);
    if (e.key === "-" || e.key === "_") cam.dist = clamp(cam.dist * 1.14, 12, 70);
    if (e.key === "r" || e.key === "R" || e.key === "0") { userMoved = false; fitView(); cam.yaw = 0.5; cam.pitch = 0.5; }
    lastInput = performance.now();
  };
  window.addEventListener("keydown", onKey);

  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let selectedName = null;
  let downAt = null;
  el.addEventListener("pointerdown", (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  el.addEventListener("pointerup", (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 6) return;
    const rect = el.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(pointer, camera);
    const hits = ray.intersectObjects(desks.map((d) => d.parts.group), true);
    if (!hits.length) selectedName = null;
    else {
      let node = hits[0].object;
      while (node.parent && !node.userData.session) node = node.parent;
      selectedName = (node.userData.session || {}).name || null;
    }
    syncSelection();
    renderCard();
  });
  overlay.addEventListener("click", (e) => {
    const tag = e.target.closest(".tag");
    if (!tag) return;
    selectedName = tag.dataset.name;
    syncSelection();
    renderCard();
  });

  function syncSelection() {
    for (const entry of desks) {
      const s = entry.session || entry.parts.group.userData.session || {};
      entry.tag.classList.toggle("selected", !!selectedName && s.name === selectedName);
    }
  }

  function renderCard() {
    const s = selectedName ? (pool.get(selectedName) || {}).session : null;
    if (!s) { card.hidden = true; return; }
    const rows = [
      ["status", s.state === "ended" ? "packed up (session ended)" : (s.status || "?")],
      ["agent", s.agent || "none detected"],
      ["where", s.repo ? `${s.repo}${s.branch ? "@" + s.branch : ""}` : "not a repository"],
      ["directory", s.dir || "-"],
      ["runtime", `${fmt(s.runtime_seconds)} · quiet ${fmt(s.idle_seconds)}`],
      ["changed", s.changed_files ? `${s.changed_files} file(s)${s.changed_sample ? " · " + s.changed_sample : ""}` : "nothing yet"],
      ["ran", s.last_command || "-"],
      ["log", s.log || "no log (open it with dev.sh session)"],
      ["attach", s.state === "ended" ? "session is gone" : `tmux attach -t ${s.name}`],
    ];
    card.innerHTML = "";
    const h = document.createElement("b");
    h.textContent = `${s.name}${s.agent ? " · " + s.agent : ""}`;
    card.append(h);
    for (const [k, v] of rows) {
      const row = document.createElement("div");
      row.className = "kv";
      const kk = document.createElement("span");
      kk.className = "k";
      kk.textContent = k;
      const vv = document.createElement("span");
      vv.textContent = v;
      row.append(kk, vv);
      card.append(row);
    }
    if (s.last_lines && s.last_lines.length) {
      const pre = document.createElement("pre");
      pre.textContent = s.last_lines.join("\n");
      card.append(pre);
    }
    card.hidden = false;
  }

  function makeTag(name) {
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.dataset.name = name;
    tag.innerHTML = '<div class="tag-top"><span class="dot"></span><b></b><span class="agent"></span></div>'
      + '<div class="tag-doing"></div><div class="tag-meta"></div>';
    overlay.append(tag);
    return tag;
  }

  const tmp = new THREE.Vector3();
  function placeTags() {
    const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
    const placed = [];
    const order = desks.map((entry) => {
      tmp.set(entry.parts.group.position.x, 3.85, entry.parts.group.position.z).project(camera);
      return { entry, x: (tmp.x * 0.5 + 0.5) * w, y: (-tmp.y * 0.5 + 0.5) * h, z: tmp.z };
    }).sort((a, b) => a.z - b.z);
    for (const item of order) {
      const tag = item.entry.tag;
      if (item.z > 1 || item.x < -120 || item.x > w + 120) { tag.style.display = "none"; continue; }
      const area = { x: item.x - 118, y: item.y - 64, w: 236, h: 64 };
      const clash = placed.some((p) => area.x < p.x + p.w && area.x + area.w > p.x && area.y < p.y + p.h && area.y + area.h > p.y);
      tag.style.display = clash ? "none" : "";
      if (!clash) placed.push(area);
      const near = clamp(1.16 - item.z * 0.3, 0.7, 1.06);
      tag.style.transform = `translate(-50%, -100%) translate(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px) scale(${near.toFixed(2)})`;
    }
  }

  let sessions = [];
  const STATUS_TEXT = {
    working: (s) => `working ${fmt(s.runtime_seconds)}`,
    waiting: (s) => `idle ${fmt(s.idle_seconds)}`,
    stale: (s) => `asleep ${fmt(s.idle_seconds)}`,
    shell: (s) => (s.agent ? `here ${fmt(s.runtime_seconds)}` : "empty desk"),
    ended: (s) => `last seen ${fmt(Math.max(0, Date.now() / 1000 - (s.ended_at || 0)))} ago`,
  };

  function update(data) {
    const live = (data && data.live) || [];
    const ended = ((data && data.ended) || []).slice(0, 8);
    sessions = [...live, ...ended];

    const cols = clamp(sessions.length <= 3 ? Math.max(1, sessions.length) : Math.ceil(sessions.length / 2), 1, 4);
    const stepX = 7.1, stepZ = 6.6;

    sessions.forEach((s, i) => {
      let entry = pool.get(s.name);
      if (!entry) {
        const parts = makeDesk(s.agent && SPECIES[s.agent] ? s.agent : "hamster");
        parts.group.userData.session = s;
        group.add(parts.group);
        entry = { parts, phase: rnd() * 6.28, sip: 5 + rnd() * 10, sipT: 99 };
        entry.tag = makeTag(s.name);
        pool.set(s.name, entry);
        desks.push(entry);
      }
      entry.session = s;
      entry.parts.group.userData.session = s;

      const row = Math.floor(i / cols), col = i % cols;
      const inRow = Math.min(cols, sessions.length - row * cols);
      entry.parts.group.position.set((col - (inRow - 1) / 2) * stepX, 0, -5.0 + row * stepZ);

      const p = entry.parts, c = p.creature;
      const status = s.state === "ended" ? "ended" : (s.status || "shell");
      // A finished session keeps its desk and its animal, asleep: that is the
      // "last known state". An empty room tells you nothing.
      c.state = status === "ended" ? "stale"
        : ["working", "waiting", "stale"].includes(status) ? status : "idle";
      p.carton.visible = false;
      c.group.visible = true;
      p.chair.visible = true;
      p.monitor.visible = true;

      const busy = status === "working";
      p.glow.intensity = busy ? 2.2 : status === "waiting" ? 0.7 : 0;
      p.pool.material.opacity = busy ? 0.17 : status === "waiting" ? 0.05 : 0;
      p.rim.material.opacity = busy ? 0.5 : status === "waiting" ? 0.18 : 0;
      p.led.material.color.set(busy ? "#6fdc96" : status === "waiting" ? "#ffbf5e" : status === "stale" ? "#e2695a" : "#c9c2b6");
      p.steam.visible = busy || status === "waiting";
      c.eyesShut.visible = status === "stale";
      c.eyesOpen.visible = status !== "stale";

      const tag = entry.tag;
      tag.className = `tag status-${status}` + (selectedName === s.name ? " selected" : "");
      const doing = s.activity || (busy ? "working" : status === "ended" ? "finished" : "idle");
      tag.querySelector("b").textContent = s.name;
      tag.querySelector(".agent").textContent = s.agent || "";
      const line = tag.querySelector(".tag-doing");
      line.textContent = `${s.activity_kind === "command" ? "$ " : ""}${String(doing).slice(0, 60)}`;
      line.title = s.last_command ? `ran: ${s.last_command}` : "";
      const where = s.repo ? `${s.repo}${s.branch ? "@" + s.branch : ""}` : "no repo";
      const was = status === "ended" && s.last_status ? ` · was ${s.last_status}` : "";
      tag.querySelector(".tag-meta").textContent =
        `${where}${s.changed_files ? ` · ${s.changed_files} changed` : ""} · ${STATUS_TEXT[status](s)}${was}`;
    });

    for (const [name, entry] of [...pool]) {
      if (sessions.some((s) => s.name === name)) continue;
      group.remove(entry.parts.group);
      entry.tag.remove();
      pool.delete(name);
      const i = desks.indexOf(entry);
      if (i >= 0) desks.splice(i, 1);
    }

    empty.hidden = sessions.length > 0;
    note.hidden = !(live.length === 0 && ended.length > 0);
    if (!sessions.length) card.hidden = true;

    if (desks.length !== lastFitted) { lastFitted = desks.length; if (!userMoved) fitView(); }
    syncSelection();
    applyCam();
    renderer.render(scene, camera);
    placeTags();
    container.dataset.desks = String(sessions.length);
  }

  const clock = new THREE.Clock();
  let catClock = 0;
  let frames = 0;

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    for (const entry of desks) {
      const p = entry.parts, c = p.creature, st = c.state, ph = entry.phase;
      const breathe = Math.sin(t * 1.5 + ph);

      c.blink -= dt;
      if (c.blink <= 0) c.blink = 2.6 + rnd() * 4.5;
      const shut = c.blink < 0.13 || st === "stale";
      c.eyesShut.visible = shut;
      c.eyesOpen.visible = !shut;

      const wag = st === "working" ? 6.5 : st === "waiting" ? 1.7 : st === "stale" ? 0.35 : 1.1;
      c.tail.rotation.y = Math.sin(t * wag + ph) * (st === "working" ? 0.3 : 0.17);

      if (st === "working") {
        c.group.position.y = SIT_Y + Math.abs(Math.sin(t * 7 + ph)) * 0.05;
        c.head.rotation.set(0.22 + Math.sin(t * 3.4) * 0.05, 0, Math.sin(t * 7 + ph) * 0.045);
        c.arms.forEach((arm, i) => { arm.rotation.x = -0.62 + Math.abs(Math.sin(t * 9 + i * 1.6)) * 0.5; });
      } else if (st === "waiting") {
        c.group.position.y = SIT_Y + breathe * 0.012;
        c.head.rotation.set(Math.sin(t * 0.8 + ph) * 0.12, Math.sin(t * 0.45 + ph) * 0.42, 0);
        c.arms.forEach((arm) => { arm.rotation.x = -0.12; });
      } else if (st === "stale") {
        c.group.position.y = SIT_Y + breathe * 0.022;
        c.head.rotation.set(0.3, 0.1, 0.42);
        c.arms.forEach((arm) => { arm.rotation.x = 0.12; });
      } else if (st === "ended") {
        /* nobody home */
      } else {
        c.group.position.y = SIT_Y + breathe * 0.018;
        c.head.rotation.set(Math.sin(t * 0.7 + ph) * 0.08, Math.sin(t * 0.4 + ph) * 0.2, Math.sin(t * 1.1 + ph) * 0.05);
        c.arms.forEach((arm) => { arm.rotation.x = -0.1; });
      }

      if (st !== "ended") {
        entry.sip -= dt;
        if (entry.sip <= 0) { entry.sip = 16 + rnd() * 28; entry.sipT = 0; }
        if (entry.sipT < 1.6) {
          entry.sipT += dt;
          const k = Math.sin(clamp(entry.sipT / 1.6, 0, 1) * Math.PI);
          p.mug.position.set(1.03 - k * 0.5, DESK_TOP + k * 0.45, -0.12 + k * 0.3);
          c.head.rotation.x += k * 0.22;
        } else if (p.mug.position.y !== DESK_TOP) {
          p.mug.position.set(1.03, DESK_TOP, -0.12);
        }
      }
      p.steam.rotation.y = t * 0.5;
      for (const [i, leaf] of p.leaves.entries()) leaf.rotation.z = Math.sin(t * 1.3 + i) * 0.05;
    }

    for (const [i, cloud] of room.life.clouds.entries()) {
      cloud.position.x += dt * (0.24 + i * 0.05);
      if (cloud.position.x > 15) cloud.position.x = -16;
    }
    const pos = dustGeo.attributes.position;
    for (let i = 0; i < DUST; i += 1) {
      pos.array[i * 3 + 1] += dt * 0.09;
      pos.array[i * 3] += Math.sin(t * 0.25 + dustSeed[i]) * dt * 0.12;
      if (pos.array[i * 3 + 1] > 9) pos.array[i * 3 + 1] = 0.4;
    }
    pos.needsUpdate = true;
    for (const l of room.life.leaves) l.node.rotation.z = l.base + Math.sin(t * 1.1 + l.phase) * 0.06;
    for (const [i, b] of room.life.bulbs.entries()) b.scale.setScalar(0.82 + Math.sin(t * 2.2 + i * 0.7) * 0.18);
    const now = new Date();
    room.hourHand.rotation.z = -((now.getHours() % 12) / 12 + now.getMinutes() / 720) * Math.PI * 2;
    room.minuteHand.rotation.z = -(now.getMinutes() / 60 + now.getSeconds() / 3600) * Math.PI * 2;

    catClock += dt;
    const cycle = (catClock % 52) / 52;
    if (cycle < 0.72) {
      const u = cycle / 0.72;
      const a = -2.4 + u * 4.8;
      cat.group.position.set(Math.sin(a) * 9.6, 0, 10.6 - Math.abs(Math.cos(a)) * 0.9);
      cat.group.rotation.y = -a + (Math.cos(a) < 0 ? Math.PI : 0);
      cat.tail.rotation.z = Math.sin(t * 4) * 0.35;
      cat.head.rotation.z = 0;
    } else {
      cat.tail.rotation.z = Math.sin(t * 1.6) * 0.2;
      cat.head.rotation.z = Math.sin(t * 1.1) * 0.12;
    }

    if (gesture === null && performance.now() - lastInput > 6000) cam.yaw += 0.0006;
    const k = 1 - Math.pow(0.0012, dt);
    cam.cyaw += (cam.yaw - cam.cyaw) * k;
    cam.cpitch += (cam.pitch - cam.cpitch) * k;
    cam.cdist += (cam.dist - cam.cdist) * k;
    cam.ctx += (cam.tx - cam.ctx) * k;
    cam.ctz += (cam.tz - cam.ctz) * k;
    applyCam();
    renderer.render(scene, camera);
    placeTags();

    frames += 1;
    if (window.__stills && frames >= window.__stills) return;
    requestAnimationFrame(frame);
  }

  const resize = () => {
    const w = stage.clientWidth || 640, h = stage.clientHeight || 420;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!userMoved) fitView();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();
  fitView();
  applyCam();
  requestAnimationFrame(frame);

  return {
    update,
    destroy() {
      ro.disconnect();
      window.removeEventListener("keydown", onKey);
      renderer.dispose();
      container.replaceChildren();
    },
    domElement: renderer.domElement,
  };
}

export function fmt(seconds) {
  if (seconds == null) return "-";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 86400)}d`;
}

let mounted = null;
let hostEl = null;

export function renderRoom3D(container, latest) {
  if (!container) return;
  if (mounted && hostEl !== container) { mounted.destroy(); mounted = null; }
  if (!mounted) { mounted = mountRoom3D(container); hostEl = container; }
  mounted.update(latest && latest.agents ? latest.agents.data : null);
}

if (typeof window !== "undefined") {
  window.renderRoom3D = renderRoom3D;
  window.dispatchEvent(new Event("room-ready"));
}
