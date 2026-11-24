"use client";

// The front page's storm, in 3D. Golden dunes under a slate-blue storm, and on them one sandbox per provider
// we've timed: a dark basin of sand with the provider's name on its side and a blue light under its rim that is
// brighter the better the router ranks it. A bolt forms in the clouds and strikes the router's pick; its sand
// fuses to glass. The others light up afterwards, each as much later as its measured start is slower: thunder.
// You hold the camera (drag to orbit); the copy slides in when you scroll. Every number is a published one.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { AfterimagePass } from "three/addons/postprocessing/AfterimagePass.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

export interface StormTower {
  id: string;
  name: string;
  /** Median time to a ready sandbox. */
  ms: number;
  /** List price per hour at the size it ran. */
  usd: number;
}
export interface StormMode {
  key: "speed" | "cost" | "value" | "failover";
  label: string;
  /** Provider ids, best first. */
  order: string[];
}
type ModeKey = StormMode["key"];
type V3 = THREE.Vector3;

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtUsd = (n: number) => (n >= 0.1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`);
const short = (name: string) => name.replace(/ (Sandbox(es)?|AI Agent Sandbox|MicroVMs|Machines|Box)$/i, "").replace(/^(Amazon|AWS) /, "");
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ease = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

// Value noise, for the dunes, the sand and the clouds.
const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const vnoise = (x: number, y: number) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi) + (hash(xi + 1, yi) - hash(xi, yi)) * u;
  const b = hash(xi, yi + 1) + (hash(xi + 1, yi + 1) - hash(xi, yi + 1)) * u;
  return a + (b - a) * v;
};
const fbm = (x: number, y: number, oct = 5) => {
  let a = 0.5;
  let f = 1;
  let s = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x * f, y * f);
    f *= 2;
    a *= 0.5;
  }
  return s;
};
/** Dune height at a point on the ground: long, smooth swells. */
const dune = (x: number, z: number) => fbm(x * 0.022 + 7, z * 0.022 + 3, 4) * 9 - 4.2 + Math.sin(x * 0.05 + z * 0.02) * 0.9;

/** A jagged 3D path from a to b by midpoint displacement. */
function jag(a: V3, b: V3, rough: number): V3[] {
  let pts = [a, b];
  let d = a.distanceTo(b) * rough;
  const off = new THREE.Vector3();
  while (d > 0.12) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const dir = q.clone().sub(p).normalize();
      off.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      off.addScaledVector(dir, -off.dot(dir)).normalize();
      next.push(p.clone().add(q).multiplyScalar(0.5).addScaledVector(off, (Math.random() - 0.5) * d), q);
    }
    pts = next;
    d *= 0.52;
  }
  return pts;
}

const SUN = new THREE.Vector3(-0.16, 0.13, -0.98).normalize();

const SKY_FRAG = `
uniform vec3 uSun; varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 top = vec3(0.010, 0.014, 0.028);
  vec3 mid = vec3(0.060, 0.045, 0.050);
  vec3 mag = vec3(0.62, 0.17, 0.045);
  vec3 org = vec3(2.2, 0.60, 0.10);
  float az = max(dot(normalize(d.xz + 1e-5), normalize(uSun.xz)), 0.0);
  vec3 c = mix(mid, top, smoothstep(0.0, 0.5, h));
  float band = exp(-pow(max(h, 0.0) / 0.11, 1.25));
  c = mix(c, mag, band * (0.2 + 0.8 * pow(az, 3.0)));
  c += org * exp(-pow(max(h, 0.0) / 0.04, 1.15)) * (0.08 + 1.25 * pow(az, 10.0));
  c = mix(c, vec3(0.025, 0.01, 0.025), smoothstep(0.0, -0.04, h));
  gl_FragColor = vec4(c, 1.0);
}`;

const FILM = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.1 }, uNeg: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
uniform sampler2D tDiffuse; uniform float uTime; uniform float uGrain; uniform float uNeg; varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 c = vUv - 0.5;
  float r = dot(c, c);
  // A lens and a film stock: colour fringes toward the corners, a vignette, grain, lifted blue shadows.
  vec3 col = vec3(texture2D(tDiffuse, vUv + c * r * 0.012).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - c * r * 0.012).b);
  col *= 1.0 - r * 1.05;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  float g = h(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 91.7) - 0.5;
  col += g * uGrain * (1.0 - 0.55 * l);
  // The instant of the strike, as a photographic negative.
  col = mix(col, vec3(0.93, 0.95, 0.96) - col * vec3(0.90, 0.72, 0.55), uNeg);
  gl_FragColor = vec4(col, 1.0);
}`,
};

interface BoltLine {
  line: Line2;
  mat: LineMaterial;
  geo: LineGeometry;
  pts: V3[];
  /** Reveal window, ms after the strike began, and how much is already drawn at the start. */
  t0: number;
  t1: number;
  from: number;
  role: "main" | "branch" | "failed" | "arc";
  width: number;
}
interface Strike {
  t0: number;
  lead: number;
  lines: BoltLine[];
  target: number;
  failed?: number;
  failAt?: number;
  origin: V3;
  tip: V3;
  mode: ModeKey | "named";
  struck: boolean;
  done: boolean[];
  last: number;
  /** The directed shot for this strike, if the camera is following. */
  shot?: { side: number };
  /** Played as the full film (cloud, dive, swing) rather than as one of many quick strikes. */
  film: boolean;
  pre: number;
}
type Phase = "idle" | "probing" | "failed" | "struck" | "thunder";

export function Storm({ towers, modes, providerCount, measuredOn }: { towers: StormTower[]; modes: StormMode[]; providerCount: number; measuredOn: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const tagRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [modeKey, setModeKey] = useState<ModeKey>("speed");
  const modeRef = useRef<ModeKey>("speed");
  const [follow, setFollow] = useState(false);
  const followRef = useRef(false);
  const [readout, setReadout] = useState<{ phase: Phase; pick?: number; failed?: number; mode: Strike["mode"]; arrived?: number }>({ phase: "idle", mode: "speed" });
  const fire = useRef<(opts?: { named?: number; mode?: ModeKey; follow?: boolean }) => void>(() => {});
  const view = useRef<(what: "overview" | "in" | "out") => void>(() => {});
  const slowest = towers.reduce((a, b) => (b.ms > a.ms ? b : a), towers[0]);

  useEffect(() => {
    const host = hostRef.current!;
    const root = rootRef.current!;
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stillAt = new URLSearchParams(location.search).get("still");
    const still = stillAt === null ? undefined : Number(stillAt);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.98;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    host.prepend(renderer.domElement);
    renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;touch-action:pan-y";

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x1b100d, 0.0046);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1200);
    const disposables: { dispose(): void }[] = [];
    const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);

    // ---- sky and light ----
    scene.add(
      new THREE.Mesh(
        keep(new THREE.SphereGeometry(900, 32, 20)),
        keep(
          new THREE.ShaderMaterial({
            side: THREE.BackSide,
            depthWrite: false,
            fog: false,
            uniforms: { uSun: { value: SUN } },
            vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: SKY_FRAG,
          }),
        ),
      ),
    );
    scene.add(new THREE.HemisphereLight(0x3d4a66, 0x2a110a, 1.1));
    const CENTER = new THREE.Vector3(0, 0, -24);
    const sun = new THREE.DirectionalLight(0xff6a26, 3.6); // the last light, low on the far horizon, rims every dune
    sun.position.copy(CENTER).addScaledVector(SUN, 220);
    sun.target.position.copy(CENTER);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, near: 10, far: 520 });
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 1.1;
    scene.add(sun, sun.target);
    const flash = new THREE.PointLight(0xd6ecff, 0, 0, 1.3);
    scene.add(flash);

    const groundGeo = keep(new THREE.PlaneGeometry(1100, 1100, 260, 260));
    groundGeo.rotateX(-Math.PI / 2);
    {
      const p = groundGeo.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, dune(p.getX(i), p.getZ(i)));
      groundGeo.computeVertexNormals();
    }
    const ground = new THREE.Mesh(groundGeo, keep(new THREE.MeshStandardMaterial({ color: 0x7a5238, roughness: 0.92 })));
    ground.receiveShadow = true;
    ground.castShadow = true;
    scene.add(ground);

    // ---- the sandboxes ----
    const BW = 5.4;
    const BH = 1.7;
    const WALL = 0.55;
    const rr = (w: number, r: number) => {
      const s = new THREE.Shape();
      const h = w / 2;
      s.moveTo(-h + r, -h);
      s.lineTo(h - r, -h);
      s.quadraticCurveTo(h, -h, h, -h + r);
      s.lineTo(h, h - r);
      s.quadraticCurveTo(h, h, h - r, h);
      s.lineTo(-h + r, h);
      s.quadraticCurveTo(-h, h, -h, h - r);
      s.lineTo(-h, -h + r);
      s.quadraticCurveTo(-h, -h, -h + r, -h);
      return s;
    };
    const basinShape = rr(BW, 0.85);
    basinShape.holes.push(rr(BW - WALL * 2, 0.5));
    const basinGeo = keep(new THREE.ExtrudeGeometry(basinShape, { depth: BH, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 4, curveSegments: 12 }));
    basinGeo.rotateX(-Math.PI / 2);
    basinGeo.translate(0, -BH / 2, 0);
    const stripShape = rr(BW - WALL * 2 + 0.02, 0.5);
    stripShape.holes.push(rr(BW - WALL * 2 - 0.34, 0.38));
    const stripGeo = keep(new THREE.ExtrudeGeometry(stripShape, { depth: 0.09, bevelEnabled: false, curveSegments: 12 }));
    stripGeo.rotateX(-Math.PI / 2);
    const basinMat = keep(new THREE.MeshStandardMaterial({ color: 0x0c1626, roughness: 0.3, metalness: 0.65 }));
    const sandGeo = keep(new THREE.PlaneGeometry(BW - WALL * 2 + 0.1, BW - WALL * 2 + 0.1, 28, 28));
    sandGeo.rotateX(-Math.PI / 2);
    {
      const p = sandGeo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const r = Math.hypot(p.getX(i), p.getZ(i)) / (BW / 2);
        p.setY(i, 0.75 * Math.max(0, 1 - r * r * 1.15) + fbm(p.getX(i) * 0.9 + 9, p.getZ(i) * 0.9, 3) * 0.35);
      }
      sandGeo.computeVertexNormals();
    }
    const plateGeo = keep(new THREE.PlaneGeometry(BW * 0.66, BW * 0.66 * 0.2));
    const hitGeo = keep(new THREE.BoxGeometry(BW + 1.2, BH + 3, BW + 1.2));
    const hitMat = keep(new THREE.MeshBasicMaterial({ visible: false }));
    const rows = [5, 6, 6];
    const slots: { x: number; z: number }[] = [];
    rows.forEach((n, r) => {
      for (let i = 0; i < n; i++) slots.push({ x: (i - (n - 1) / 2) * (15 + r * 2.4) + (r % 2 ? 4 : -3) + rnd(-2, 2), z: -2 - r * 21 + rnd(-3.5, 3.5) });
    });
    const SAND = new THREE.Color(0xe2bd86);
    const GLASS = new THREE.Color(0xd4eef2);
    const boxes = towers.map((t, i) => {
      const s = slots[(i * 7) % slots.length];
      const scale = 0.9 + hash(i, 3) * 0.4;
      const y = dune(s.x, s.z) + (BH / 2) * scale - 0.35;
      const g = new THREE.Group();
      g.position.set(s.x, y, s.z);
      g.rotation.y = rnd(-0.5, 0.5);
      g.scale.setScalar(scale);
      const basin = new THREE.Mesh(basinGeo, basinMat);
      basin.castShadow = true;
      basin.receiveShadow = true;
      g.add(basin);
      const sandMat = keep(new THREE.MeshStandardMaterial({ color: SAND.clone(), roughness: 0.95, emissive: 0x000000 }));
      const sand = new THREE.Mesh(sandGeo, sandMat);
      sand.position.y = BH / 2 - 0.75;
      sand.receiveShadow = true;
      g.add(sand);
      const stripMat = keep(new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false, fog: false }));
      const strip = new THREE.Mesh(stripGeo, stripMat);
      strip.position.y = BH / 2 - 0.1;
      g.add(strip);
      // The name, lettered on all four sides of the basin.
      const c = document.createElement("canvas");
      c.width = 640;
      c.height = 128;
      const x = c.getContext("2d")!;
      x.fillStyle = "#f1cf8a";
      x.textAlign = "center";
      x.textBaseline = "middle";
      const label = short(t.name).toUpperCase();
      x.font = `600 ${label.length > 11 ? 58 : 76}px ui-sans-serif, system-ui, sans-serif`;
      if ("letterSpacing" in x) (x as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "10px";
      x.fillText(label, 320, 68);
      const tex = keep(new THREE.CanvasTexture(c));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      const plateMat = keep(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
      for (let k = 0; k < 4; k++) {
        const pl = new THREE.Mesh(plateGeo, plateMat);
        pl.rotation.y = (k * Math.PI) / 2;
        pl.position.set(Math.sin((k * Math.PI) / 2) * (BW / 2 + 0.13), 0, Math.cos((k * Math.PI) / 2) * (BW / 2 + 0.13));
        g.add(pl);
      }
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.userData.i = i;
      g.add(hit);
      scene.add(g);
      const top = new THREE.Vector3(s.x, y + (BH / 2 - 0.1) * scale, s.z);
      return { t, sandMat, stripMat, plateMat, hit, top, base: new THREE.Vector3(s.x, dune(s.x, s.z), s.z), scale, heat: 0, glass: 0, rank: 0, place: 99, state: "idle" as "idle" | "down" | "hot" | "late", tagUntil: 0, metric: "" };
    });
    const setTag = (i: number, metric: string, tone: "idle" | "hot" | "late" | "down") => {
      boxes[i].metric = metric;
      const el = tagRefs.current[i];
      if (!el) return;
      (el.children[0] as HTMLElement).textContent = `${boxes[i].place < 5 && tone !== "down" ? `${boxes[i].place + 1}  ` : ""}${short(towers[i].name)}`;
      (el.children[1] as HTMLElement).textContent = metric;
      el.dataset.tone = tone;
    };
    const metric = (i: number, mode: ModeKey) => (mode === "cost" ? `${fmtUsd(towers[i].usd)}/h` : mode === "value" ? `${fmtMs(towers[i].ms)} · ${fmtUsd(towers[i].usd)}/h` : fmtMs(towers[i].ms));
    const relabel = (mode: ModeKey) => {
      const order = (modes.find((m) => m.key === mode) ?? modes[0]).order;
      boxes.forEach((b, i) => {
        const r = order.indexOf(b.t.id);
        b.rank = r < 0 ? 1 : r / Math.max(1, order.length - 1);
        b.place = r < 0 ? 99 : r;
        b.state = "idle";
        b.glass = 0;
        b.tagUntil = 0;
        setTag(i, metric(i, mode), "idle");
      });
    };
    relabel("speed");

    // ---- clouds, and sand blowing off the crests ----
    const cloudTex = [0, 1, 2, 3].map((seed) => {
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      const g = c.getContext("2d")!;
      const img = g.createImageData(256, 256);
      for (let y = 0; y < 256; y++)
        for (let x = 0; x < 256; x++) {
          const d = Math.hypot(x - 128, y - 128) / 128;
          const n = fbm(x * 0.022 + seed * 31, y * 0.022 + seed * 17, 5);
          const a = clamp((n * 1.9 - 0.42) * (1 - ease((d - 0.3) / 0.7)), 0, 1);
          const k = (y * 256 + x) * 4;
          const shade = 190 + 65 * fbm(x * 0.05 + seed, y * 0.05, 3);
          img.data[k] = img.data[k + 1] = img.data[k + 2] = shade;
          img.data[k + 3] = a * 255;
        }
      g.putImageData(img, 0, 0);
      return keep(new THREE.CanvasTexture(c));
    });
    const clouds = Array.from({ length: 150 }, (_, i) => {
      const z = rnd(-380, 80);
      const far = clamp(-z / 320, 0, 1);
      const pos = new THREE.Vector3(rnd(-300, 300), rnd(42, 78) - far * 12, z);
      // Near clouds are storm-dark; the far ones catch the orange off the horizon.
      const base = new THREE.Color().setRGB(0.04 + far * 0.8, 0.035 + far * 0.24, 0.045 + far * 0.05).multiplyScalar(0.5 + Math.random() * 0.6);
      const mat = keep(new THREE.SpriteMaterial({ map: cloudTex[i % 4], color: base.clone(), transparent: true, opacity: rnd(0.45, 0.9), depthWrite: false, fog: false, rotation: rnd(0, 6.28) }));
      const s = new THREE.Sprite(mat);
      const size = rnd(80, 170);
      s.scale.set(size, size * rnd(0.45, 0.7), 1);
      s.position.copy(pos);
      scene.add(s);
      return { s, mat, base, glow: 0, drift: rnd(0.4, 1.6) };
    });
    const cell = clouds.slice(0, 22);
    cell.forEach((c) => {
      c.base.setRGB(0.05, 0.04, 0.045);
      c.mat.opacity = 0.4;
    });
    const wisps = Array.from({ length: 30 }, (_, i) => {
      const mat = keep(new THREE.SpriteMaterial({ map: cloudTex[i % 4], color: new THREE.Color(0.9, 0.42, 0.34), transparent: true, opacity: rnd(0.04, 0.11), depthWrite: false }));
      const s = new THREE.Sprite(mat);
      const w = rnd(26, 60);
      s.scale.set(w, w * rnd(0.12, 0.22), 1);
      s.position.set(rnd(-150, 150), 0, rnd(-140, 50));
      scene.add(s);
      return { s, v: rnd(2.5, 7), lift: rnd(1.2, 4) };
    });
    // The dust a strike throws off: one soft ring that rolls outward along the ground.
    const ringTex = (() => {
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      const g = c.getContext("2d")!;
      const img = g.createImageData(256, 256);
      for (let y = 0; y < 256; y++)
        for (let x = 0; x < 256; x++) {
          const d = Math.hypot(x - 128, y - 128) / 128;
          const a = Math.exp(-(((d - 0.72) / 0.13) ** 2)) * (0.45 + 0.75 * fbm(x * 0.04, y * 0.04, 4)) * (d < 1 ? 1 : 0);
          const k = (y * 256 + x) * 4;
          img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
          img.data[k + 3] = clamp(a, 0, 1) * 255;
        }
      g.putImageData(img, 0, 0);
      return keep(new THREE.CanvasTexture(c));
    })();
    const dustMat = keep(new THREE.MeshBasicMaterial({ map: ringTex, color: new THREE.Color(1.1, 0.6, 0.42), transparent: true, opacity: 0, depthWrite: false }));
    const dustGeo = keep(new THREE.PlaneGeometry(1, 1));
    dustGeo.rotateX(-Math.PI / 2);
    const dust = new THREE.Mesh(dustGeo, dustMat);
    dust.renderOrder = 3;
    scene.add(dust);

    // ---- rain, which comes and goes ----
    const RAIN = 1500;
    const rainGeo = keep(new THREE.BufferGeometry());
    const rainPos = new Float32Array(RAIN * 6);
    const rainSeed = Array.from({ length: RAIN }, () => ({ x: rnd(-80, 80), y: rnd(0, 70), z: rnd(-80, 80), v: rnd(46, 78) }));
    rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
    const rainMat = keep(new THREE.LineBasicMaterial({ color: 0xd4e2ff, transparent: true, opacity: 0, depthWrite: false }));
    const rainMesh = new THREE.LineSegments(rainGeo, rainMat);
    rainMesh.frustumCulled = false;
    scene.add(rainMesh);

    // ---- post: bloom, a brief long-exposure smear at the strike, then film ----
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.7, 1.0));
    const smear = new AfterimagePass(0);
    composer.addPass(smear);
    composer.addPass(new OutputPass());
    const film = new ShaderPass(FILM);
    composer.addPass(film);
    const lineMats = new Set<LineMaterial>();
    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.fov = w < h ? 56 : 38;
      camera.updateProjectionMatrix();
      lineMats.forEach((m) => m.resolution.set(w, h));
    };
    resize();
    window.addEventListener("resize", resize);

    // ---- the bolt ----
    let strike: Strike | undefined;
    const say = (() => {
      let lastKey = "";
      return (p: typeof readout) => {
        const k = `${p.phase}${p.pick ?? ""}${p.arrived ?? ""}${p.failed ?? ""}`;
        if (k !== lastKey) {
          lastKey = k;
          setReadout(p);
        }
      };
    })();
    const addLine = (pts: V3[], role: BoltLine["role"], width: number, t0: number, t1: number, from = 0): BoltLine => {
      const flat = new Float32Array(pts.length * 3);
      pts.forEach((p, i) => p.toArray(flat, i * 3));
      const geo = new LineGeometry();
      geo.setPositions(flat);
      const mat = new LineMaterial({ color: 0xffffff, linewidth: width, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
      mat.resolution.set(host.clientWidth, host.clientHeight);
      lineMats.add(mat);
      const line = new Line2(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 5;
      scene.add(line);
      return { line, mat, geo, pts, t0, t1, from, role, width };
    };
    const clear = () => {
      strike?.lines.forEach((l) => {
        scene.remove(l.line);
        l.geo.dispose();
        l.mat.dispose();
        lineMats.delete(l.mat);
      });
      strike = undefined;
    };
    const forks = (main: V3[], t0: number, t1: number, n: number, out: BoltLine[], reach: number) => {
      for (let i = 0; i < n; i++) {
        const f = rnd(0.05, 0.85);
        const a = main[Math.floor(f * (main.length - 1))];
        const b = a.clone().add(new THREE.Vector3(rnd(-1, 1), rnd(-1.1, 0.1), rnd(-1, 1)).normalize().multiplyScalar(rnd(0.25, 1) * reach));
        b.y = Math.max(b.y, dune(b.x, b.z) + 3);
        const pts = jag(a, b, 0.32);
        const s = t0 + (t1 - t0) * f;
        out.push(addLine(pts, "branch", rnd(1, 2), s, s + (t1 - t0) * 0.5));
        if (Math.random() < 0.6) {
          const a2 = pts[Math.floor(rnd(0.3, 0.8) * (pts.length - 1))];
          const b2 = a2.clone().add(new THREE.Vector3(rnd(-1, 1), rnd(-1, -0.1), rnd(-1, 1)).normalize().multiplyScalar(reach * rnd(0.15, 0.45)));
          out.push(addLine(jag(a2, b2, 0.34), "branch", 0.9, s + 80, s + (t1 - t0) * 0.5));
        }
      }
    };

    // ---- camera: yours to hold. An orbit around a point on the field; a strike can borrow it if you let it. ----
    const orbit = { theta: 0.1, phi: 1.37, r: 92, target: CENTER.clone().setY(9) };
    const want = { theta: 0.1, phi: 1.37, r: 92, target: CENTER.clone().setY(9) };
    const camPos = new THREE.Vector3(30, 60, 60);
    const camLook = CENTER.clone();
    const wantPos = new THREE.Vector3();
    const wantLook = new THREE.Vector3();
    const tmp3 = new THREE.Vector3();
    const tmpC = new THREE.Color();
    let directed = false;
    let handBack = 0;
    let lastInput = performance.now() - 3000;
    const orbitPos = (o: typeof orbit, out: V3) => out.set(Math.sin(o.phi) * Math.sin(o.theta), Math.cos(o.phi), Math.sin(o.phi) * Math.cos(o.theta)).multiplyScalar(o.r).add(o.target);
    const release = () => {
      // Hand the camera back where the shot left it, so nothing jumps.
      if (!directed) return;
      directed = false;
      handBack = performance.now();
      const d = tmp3.copy(camPos).sub(want.target);
      want.r = orbit.r = clamp(d.length(), 16, 170);
      want.phi = orbit.phi = clamp(Math.acos(clamp(d.y / d.length(), -1, 1)), 0.12, 1.5);
      want.theta = orbit.theta = Math.atan2(d.x, d.z);
    };
    view.current = (what) => {
      lastInput = performance.now(); // moving the camera yourself holds off the next film for a few seconds
      if (what === "overview") {
        release();
        want.target.copy(CENTER).setY(9);
        want.r = 92;
        want.phi = 1.37;
        want.theta = 0.1;
      } else want.r = clamp(want.r * (what === "in" ? 0.72 : 1.38), 16, 170);
    };

    const idx = (id: string) => towers.findIndex((t) => t.id === id);
    let auto = 0;
    let nextAuto = 900;
    let opened = false;
    fire.current = (opts = {}) => {
      clear();
      const mode = opts.mode ?? modeRef.current;
      const m = modes.find((x) => x.key === mode) ?? modes[0];
      const ranked = m.order.map(idx).filter((i) => i >= 0);
      const named = opts.named;
      const target = named ?? (mode === "failover" && ranked.length > 1 ? ranked[1] : ranked[0]);
      const first = named === undefined && mode === "failover" && ranked.length > 1 ? ranked[0] : undefined;
      relabel(mode);
      const aim = boxes[first ?? target].top;
      const origin = new THREE.Vector3(aim.x + rnd(-18, 18), rnd(54, 60), aim.z + rnd(-16, 12));
      const lines: BoltLine[] = [];
      let mainLine: BoltLine;
      const film = (opts.follow ?? followRef.current) && !calm;
      // In the cloud first: it charges, small arcs jump and join, and only then does anything come out of it.
      const pre = film ? 2600 : 520;
      let lead = pre + (film ? rnd(800, 1050) : rnd(650, 900));
      // The charge gathers: each arc starts where the last one ended, spiralling in to the point the bolt will leave from.
      const NODES = film ? 8 : 3;
      const spin = rnd(0, 6.28);
      const node = (i: number) => {
        const r = (film ? 30 : 12) * (1 - i / NODES) ** 0.85;
        const a = spin + i * 1.9;
        return i >= NODES ? origin.clone() : origin.clone().add(new THREE.Vector3(Math.cos(a) * r, rnd(-2.5, 2.5), Math.sin(a) * r));
      };
      const chain = Array.from({ length: NODES + 1 }, (_, i) => node(i));
      for (let i = 0; i < NODES; i++) {
        const at = pre * 0.05 + ((pre * 0.85) / NODES) * i;
        lines.push(addLine(jag(chain[i], chain[i + 1], 0.24), "arc", 2.4 + (i / NODES) * 2.4, at, at + (pre * 0.8) / NODES));
        if (film && i > 0 && i % 2 === 0) lines.push(addLine(jag(chain[i], chain[i - 2], 0.3), "arc", 1.6, at + 120, at + 120 + (pre * 0.8) / NODES));
      }
      // Gather the storm cell around where it will come from, so the camera starts inside cloud.
      cell.forEach((c) => c.s.position.copy(origin).add(tmp3.set(rnd(-46, 46), rnd(-3, 14), rnd(-46, 46))));
      let failAt: number | undefined;
      if (first !== undefined) {
        // The first try reaches a box that is down; the bolt forks off partway and finds the next one.
        failAt = lead;
        const a = jag(origin, boxes[first].top, 0.2);
        lines.push(addLine(a, "failed", 2.4, pre, failAt));
        const k = Math.floor(a.length * 0.45);
        lead = failAt + rnd(900, 1200);
        mainLine = addLine([...a.slice(0, k), ...jag(a[k], boxes[target].top, 0.22)], "main", 6, failAt + 250, lead, 0.45);
        forks(a, pre, failAt, 6, lines, 20);
      } else {
        const main = jag(origin, boxes[target].top, 0.2);
        mainLine = addLine(main, "main", 6, pre, lead);
        forks(main, pre, lead, 9, lines, 24);
        // Probes: it feels for a few other boxes before it commits.
        const near = boxes
          .map((_, i) => i)
          .filter((i) => i !== target)
          .sort((p, q) => boxes[p].top.distanceTo(boxes[target].top) - boxes[q].top.distanceTo(boxes[target].top))
          .slice(0, 5)
          .sort(() => Math.random() - 0.5)
          .slice(0, 3);
        for (const o of near) {
          const f = rnd(0.25, 0.6);
          const a = main[Math.floor(f * (main.length - 1))];
          lines.push(addLine(jag(a, a.clone().lerp(boxes[o].top, rnd(0.7, 0.96)), 0.26), "branch", 1.8, pre + (lead - pre) * f, lead * 0.98));
        }
      }
      lines.unshift(mainLine);
      strike = {
        t0: performance.now(),
        lead,
        lines,
        target,
        failed: first,
        failAt,
        origin,
        tip: origin.clone(),
        mode: named !== undefined ? "named" : mode,
        struck: false,
        done: boxes.map(() => false),
        last: 0,
        shot: film ? { side: Math.random() < 0.5 ? -1 : 1 } : undefined,
        film,
        pre,
      };
      if (strike.shot) {
        directed = true;
        direct(strike, 0, -1);
        camPos.copy(wantPos); // a cut, not a fly-over
        camLook.copy(wantLook);
      }
      say({ phase: "probing", mode: strike.mode });
    };
    /** The film of one strike: in the cloud, down the bolt from above, then round to the side of the box. */
    const direct = (st: Strike, t: number, s: number) => {
      const tgt = boxes[st.target].top;
      const o = st.origin;
      const side = st.shot!.side;
      const pre = st.pre;
      if (t < pre) {
        // Through the cloud toward the charge, with the field showing below.
        const a = ease(t / pre);
        wantPos.set(o.x + side * (38 - 28 * a), o.y + 7 + 6 * a, o.z + 50 - 36 * a);
        wantLook.copy(o).lerp(tgt, 0.42 - 0.12 * a);
      } else if (s < 450) {
        // It drops, and the camera dives after it out of the cloud: straight down the bolt at the box it found.
        const a = ease((t - pre) / Math.max(1, st.lead - pre));
        wantPos.set(o.x + side * 6, o.y + 11, o.z + 8).lerp(tmp3.set(tgt.x + side * 6, tgt.y + 36, tgt.z + 12), a);
        wantLook.copy(o).lerp(tgt, ease((t - pre) / 380));
      } else {
        // Then round and down to the side of the box, in time for the thunder.
        const a = ease((s - 450) / 1900);
        wantPos.set(tgt.x + side * 6, tgt.y + 36, tgt.z + 12).lerp(tmp3.copy(tgt).add(new THREE.Vector3(side * 17, 5.5, 21)), a);
        wantLook.copy(tgt);
      }
    };

    // ---- pointer ----
    const mouse = new THREE.Vector2(0, 0);
    let hover = -1;
    const ray = new THREE.Raycaster();
    const hits = boxes.map((b) => b.hit);
    let drag: { x: number; y: number; moved: number } | undefined;
    const pickAt = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(mouse, camera);
      const h = ray.intersectObjects(hits, false)[0];
      return h ? (h.object.userData.i as number) : -1;
    };
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("a,button,code,[data-panel]")) return;
      drag = { x: e.clientX, y: e.clientY, moved: 0 };
    };
    const move = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        drag.x = e.clientX;
        drag.y = e.clientY;
        if (drag.moved > 6) {
          release();
          if (strike) strike.shot = undefined;
          want.theta -= dx * 0.0055;
          want.phi = clamp(want.phi - dy * 0.0045, 0.12, 1.5);
          lastInput = performance.now();
        }
        host.style.cursor = "grabbing";
        return;
      }
      hover = (e.target as HTMLElement).closest("a,button,[data-panel]") ? -1 : pickAt(e);
      host.style.cursor = hover >= 0 ? "pointer" : "grab";
    };
    const up = (e: PointerEvent) => {
      const d = drag;
      drag = undefined;
      if (!d || d.moved > 6) return;
      lastInput = performance.now();
      const h = pickAt(e);
      fire.current(h >= 0 ? { named: h } : {});
    };
    const dbl = (e: MouseEvent) => {
      const h = pickAt(e as PointerEvent);
      if (h < 0) return;
      release();
      want.target.copy(boxes[h].top);
      want.r = 26;
      want.phi = 1.1;
    };
    const key = (e: KeyboardEvent) => {
      const n = "1234".indexOf(e.key);
      if (e.key === "=" || e.key === "+") return view.current("in");
      if (e.key === "-") return view.current("out");
      if (e.key === "0") return view.current("overview");
      if (n >= 0 && modes[n]) {
        modeRef.current = modes[n].key;
        setModeKey(modes[n].key);
      } else if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      lastInput = performance.now();
      fire.current();
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("dblclick", dbl);
    window.addEventListener("keydown", key);

    const ambient: { l: BoltLine; born: number }[] = [];
    let nextAmbient = 1500;
    let raf = 0;
    let last = performance.now();
    let nextGlow = 400;
    let scrolled = false;
    let dustAt = -1e9;
    const dustPos = new THREE.Vector3();
    const proj = new THREE.Vector3();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(50, now - last);
      last = now;
      // How far the page has scrolled past the demo: drives the copy sliding in.
      const p = clamp((window.scrollY - root.offsetTop) / (window.innerHeight * 0.85), 0, 1);
      root.style.setProperty("--p", p.toFixed(3));
      if (p > 0.06 && !scrolled) {
        scrolled = true;
        if (strike) strike.shot = undefined;
        view.current("overview");
      } else if (p < 0.02) scrolled = false;
      if (p > 0.001) camera.setViewOffset(host.clientWidth, host.clientHeight, -p * host.clientWidth * 0.2, 0, host.clientWidth, host.clientHeight);
      else if (camera.view) camera.clearViewOffset();

      if (still !== undefined && strike && now - strike.t0 - strike.lead > still) strike.t0 = now - strike.lead - still;
      const t = strike ? now - strike.t0 : 0;
      const s = strike ? t - strike.lead : -1;
      const k = s >= 0 ? Math.exp(-s / 480) + 0.8 * Math.exp(-(((s - 190) / 60) ** 2)) + 0.45 * Math.exp(-(((s - 380) / 70) ** 2)) : 0;

      const arcOn = strike?.lines.some((l) => l.role === "arc" && t >= l.t0 && t <= l.t1) ? 1 : 0;
      // Clouds drift and flicker on their own; the one about to strike charges up, then lights everything near it.
      nextGlow -= dt;
      if (nextGlow < 0) {
        const c = clouds[Math.floor(Math.random() * clouds.length)];
        c.glow = Math.max(c.glow, rnd(0.1, 0.45));
        nextGlow = rnd(220, 1500);
      }
      for (const c of clouds) {
        c.s.position.x += (dt / 1000) * c.drift;
        if (c.s.position.x > 350) c.s.position.x = -350;
        c.glow *= Math.exp(-dt / 210);
        let lit = c.glow;
        if (strike) {
          const d = c.s.position.distanceTo(strike.origin);
          const charge = s < 0 ? (0.01 + 0.03 * ease(t / strike.lead)) * (0.5 + Math.random()) + arcOn * rnd(0.06, 0.2) : 0;
          lit += (k * 0.55 + charge) * Math.exp(-d / 62);
        }
        c.mat.color.copy(c.base).add(tmpC.setRGB(0.62, 0.8, 1.0).multiplyScalar(lit));
      }
      for (const w of wisps) {
        w.s.position.x += (dt / 1000) * w.v;
        if (w.s.position.x > 160) w.s.position.set(-160, 0, rnd(-140, 50));
        w.s.position.y = dune(w.s.position.x, w.s.position.z) + w.lift;
      }

      // Far-off strikes on the horizon.
      nextAmbient -= dt;
      if (nextAmbient < 0 && !calm) {
        nextAmbient = rnd(900, 3200);
        const a = new THREE.Vector3(rnd(-280, 280), rnd(52, 62), rnd(-340, -130));
        const b = new THREE.Vector3(a.x + rnd(-40, 40), 0, a.z + rnd(-25, 25));
        b.y = dune(b.x, b.z);
        ambient.push({ l: addLine(jag(a, b, 0.2), "branch", rnd(1.6, 3.2), 0, 1), born: now });
        for (const c of clouds) if (c.s.position.distanceTo(a) < 90) c.glow = Math.max(c.glow, rnd(0.5, 1.1));
      }
      for (let i = ambient.length - 1; i >= 0; i--) {
        const age = now - ambient[i].born;
        const { l } = ambient[i];
        const b = (2.4 * Math.exp(-age / 130) + 1.2 * Math.exp(-(((age - 210) / 45) ** 2))) * (0.8 + Math.random() * 0.4);
        l.mat.color.setRGB(b * 0.97, b * 0.94, b * 1.14);
        if (age > 480) {
          scene.remove(l.line);
          l.geo.dispose();
          l.mat.dispose();
          lineMats.delete(l.mat);
          ambient.splice(i, 1);
        }
      }

      // The bolt: leaders creep out dim, then the return stroke.
      flash.intensity = 0;
      smear.uniforms.damp.value = 0;
      film.uniforms.uNeg.value = 0;
      if (strike) {
        const st = strike;
        for (const l of st.lines) {
          if (l.role === "arc") {
            // Once an arc has formed it stays lit, so the whole chain is glowing by the time it lets go.
            const segs = l.pts.length - 1;
            const shown = t < l.t0 ? 0 : Math.max(1, Math.floor(segs * ease((t - l.t0) / (l.t1 - l.t0))));
            const b = s >= 0 ? 2.4 * Math.exp(-s / 260) : t < l.t1 ? 2.6 : 0.5 + Math.random() * 0.4 + 1.8 * ease((t - (st.pre - 380)) / 380);
            l.geo.instanceCount = shown;
            l.line.visible = shown > 0 && b > 0.02;
            l.mat.color.setRGB(b * 0.9, b * 0.95, b * 1.2);
            continue;
          }
          const g = l.from + (1 - l.from) * ease((t - l.t0) / (l.t1 - l.t0)) ** 1.5;
          const segs = l.pts.length - 1;
          const shown = t < l.t0 ? 0 : Math.max(1, Math.floor(segs * (s >= 0 && l.role === "main" ? 1 : g)));
          l.geo.instanceCount = shown;
          if (shown > 0 && ((l.role === "main" && (st.failAt === undefined || t >= st.failAt)) || (l.role === "failed" && t < st.failAt!))) st.tip.copy(l.pts[Math.min(shown, segs)]);
          let b: number;
          if (l.role === "failed") b = t < st.failAt! ? 0.9 : 1.4 * Math.exp(-(t - st.failAt!) / 260);
          else if (s < 0) b = (l.role === "main" ? 1.0 : 0.6) * (0.75 + Math.random() * 0.5);
          else if (l.role === "main") b = 0.1 * Math.max(0, 1 - s / 2600) + k * 3.4 * (0.85 + Math.random() * 0.3);
          else b = 2.2 * Math.exp(-s / 240);
          if (l.role === "failed") l.mat.color.setRGB(b * 0.55, b * 0.8, b * 1.25);
          else l.mat.color.setRGB(b * 0.97, b * 0.94, b * 1.14);
          l.mat.linewidth = l.width * (l.role === "main" && s >= 0 ? 1 + k * 0.6 : s < 0 ? 0.55 : 1);
          l.line.visible = b > 0.01 && shown > 0;
        }
        if (st.failed !== undefined && t >= st.failAt! && boxes[st.failed].state !== "down") {
          boxes[st.failed].state = "down";
          setTag(st.failed, "down", "down");
          say({ phase: "failed", failed: st.failed, mode: st.mode });
        }
        if (s >= 0) {
          const hitBox = boxes[st.target];
          flash.position.copy(hitBox.top).add(tmp3.set(0, 15, 6));
          flash.intensity = k * 230;
          if (!calm) smear.uniforms.damp.value = 0.82 * Math.min(1, k * 1.4);
          if (!calm && s < 70) film.uniforms.uNeg.value = 1;
          if (!st.struck) {
            st.struck = true;
            hitBox.state = "hot";
            hitBox.heat = 1;
            hitBox.glass = 1;
            setTag(st.target, `ready in ${fmtMs(hitBox.t.ms)}`, "hot");
            dustAt = now;
            dustPos.copy(hitBox.base);
            say({ phase: "struck", pick: st.target, failed: st.failed, mode: st.mode });
          }
          // Thunder: everyone else, arriving as much later as they are slower.
          let waiting = 0;
          boxes.forEach((b, i) => {
            if (i === st.target || i === st.failed || st.done[i]) return;
            const late = Math.max(0, b.t.ms - hitBox.t.ms);
            if (s >= (st.film ? late : Math.min(late * 0.5, 1600)) + 140) {
              st.done[i] = true;
              st.last = i;
              b.state = "late";
              b.heat = 1;
              b.tagUntil = now + 1700;
              setTag(i, late > 0 ? `+${fmtMs(late)}` : `${fmtMs(b.t.ms)}, sooner`, "late");
            } else waiting++;
          });
          if (waiting === 0 && s > 400) say({ phase: "thunder", pick: st.target, failed: st.failed, mode: st.mode, arrived: st.last });
          if (waiting === 0 && s > (st.film ? Math.max(3600, slowest.ms - hitBox.t.ms + 1700) : 2500)) {
            const wasFilm = st.film;
            clear();
            release();
            nextAuto = wasFilm ? rnd(900, 1600) : rnd(350, 900);
            if (wasFilm) {
              // After the film, pull back to where the whole field is in view for the strikes that follow.
              want.target.copy(CENTER).setY(9);
              want.r = 92;
              want.phi = 1.37;
              want.theta = 0.1;
            }
            // The storm passes: the glass stays, everything else goes back to showing its rank.
            boxes.forEach((b, i) => {
              if (b.state === "late" || b.state === "down") {
                b.state = "idle";
                setTag(i, metric(i, modeRef.current), "idle");
              }
            });
          }
        }
      }

      // The dust ring rolls out from the strike and thins.
      const da = (now - dustAt) / 1900;
      dust.visible = da >= 0 && da < 1 && !calm;
      if (dust.visible) {
        const r = 7 + 26 * (1 - (1 - da) ** 2.2);
        dust.scale.set(r, 1, r);
        dust.position.copy(dustPos).setY(dustPos.y + 0.9 + da * 1.5);
        dustMat.opacity = 0.26 * (1 - da) ** 1.4;
      }

      // Each box: the blue under its rim says how the router ranks it; struck sand turns to glass.
      boxes.forEach((b, i) => {
        b.heat *= Math.exp(-dt / (b.state === "hot" ? 2400 : 900));
        const best = (1 - b.rank) ** 1.8;
        const hv = i === hover ? 1.7 : 1;
        if (b.state === "down") b.stripMat.color.setRGB(0.01, 0.015, 0.02);
        else if (b.state === "hot") b.stripMat.color.setRGB(1.0 + b.heat * 1.2, 1.3 + b.heat * 1.3, 1.8 + b.heat * 1.4);
        else if (b.state === "late") b.stripMat.color.setRGB(0.12 + b.heat * 2.6, 0.3 + b.heat * 1.9, 0.6 + b.heat * 0.4);
        else b.stripMat.color.setRGB((0.03 + best * 0.45) * hv, (0.2 + best * 1.9) * hv, (0.6 + best * 4.2) * hv);
        b.sandMat.color.copy(SAND).lerp(GLASS, b.glass * 0.8);
        b.sandMat.roughness = 0.95 - b.glass * 0.75;
        if (b.state === "hot") b.sandMat.emissive.setRGB(0.75, 0.92, 1.0).multiplyScalar(0.08 + b.heat * 0.9);
        else b.sandMat.emissive.setRGB(0.05, 0.3, 0.9).multiplyScalar(b.state === "idle" ? best * 0.55 : 0);
        b.plateMat.color.setScalar(b.state === "down" ? 0.28 : b.state === "hot" ? 1.7 : 0.7 + best * 0.6);
        // The tag: drawn over the box it belongs to, only when it has something to say.
        const el = tagRefs.current[i];
        if (!el) return;
        proj.copy(b.top).setY(b.top.y + 2.4 * b.scale).project(camera);
        const dist = camera.position.distanceTo(b.top);
        const show = proj.z < 1 && (p < 0.5 || proj.x > 0.05) && camera.position.y < 45 && (b.state === "hot" || b.state === "down" || i === hover || now < b.tagUntil || (b.state === "idle" && b.place < 5) || dist < 46);
        el.style.opacity = show ? "1" : "0";
        if (show) el.style.transform = `translate(-50%, -100%) translate(${((proj.x + 1) / 2) * host.clientWidth}px, ${((1 - proj.y) / 2) * host.clientHeight}px)`;
      });

      // Rain comes and goes.
      const wet = clamp((fbm(now / 14000, 3.3, 2) - 0.4) * 6, 0, 1);
      rainMat.opacity = 0.2 * wet;
      rainMesh.visible = wet > 0.01;
      if (rainMesh.visible) {
        for (let i = 0; i < RAIN; i++) {
          const d = rainSeed[i];
          d.y -= (dt / 1000) * d.v;
          if (d.y < -4) d.y = 70;
          const x = camera.position.x + d.x;
          const y = camera.position.y - 30 + d.y;
          const z = camera.position.z + d.z;
          rainPos.set([x, y, z, x + 0.3, y + 1.7, z], i * 6);
        }
        rainGeo.attributes.position.needsUpdate = true;
      }

      // Camera.
      const f = 1 - Math.exp(-dt / 110);
      orbit.theta += (want.theta - orbit.theta) * f;
      orbit.phi += (want.phi - orbit.phi) * f;
      orbit.r += (want.r - orbit.r) * f;
      orbit.target.lerp(want.target, f);
      let follow = 1 - Math.exp(-dt / 320);
      if (directed && strike?.shot) direct(strike, t, s);
      else {
        if (directed) release();
        orbitPos(orbit, wantPos);
        wantLook.copy(orbit.target);
        follow = now - handBack < 1500 ? 1 - Math.exp(-dt / 420) : 1;
      }
      camPos.lerp(wantPos, follow);
      camLook.lerp(wantLook, follow);
      camPos.y = Math.max(camPos.y, dune(camPos.x, camPos.z) + 1.6);
      camera.position.copy(camPos);
      camera.lookAt(camLook);
      if (strike && s >= 0 && !calm) {
        // A jolt when it lands, then the thunder rolls through: one slow rumble, not a jitter.
        const a = 0.9 * Math.exp(-s / 150) + (s > 650 ? 1.1 * ease((s - 650) / 250) * Math.exp(-(s - 650) / 1000) : 0);
        camera.rotateZ(Math.sin(now * 0.043) * a * 0.011 + Math.sin(now * 0.097) * a * 0.005);
        camera.rotateX(Math.cos(now * 0.051) * a * 0.008);
      }

      film.uniforms.uTime.value = now / 1000;
      composer.render();

      // The opening: ride the first bolt down from the cloud. After that, strikes keep coming while you look around.
      if (!strike && (!opened || now - lastInput > 2200)) {
        nextAuto -= dt;
        if (nextAuto < 0) {
          const cycle: ModeKey[] = ["speed", "cost", "failover", "value"];
          const m = cycle[auto++ % cycle.length];
          modeRef.current = m;
          setModeKey(m);
          fire.current({ mode: m, follow: opened ? undefined : true });
          opened = true;
        }
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("dblclick", dbl);
      window.removeEventListener("keydown", key);
      clear();
      disposables.forEach((d) => d.dispose());
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [towers, modes, slowest]);

  const pickMode = useCallback((k: ModeKey) => {
    modeRef.current = k;
    setModeKey(k);
    fire.current({ mode: k });
  }, []);
  const toggleFollow = useCallback(() => {
    followRef.current = !followRef.current;
    setFollow(followRef.current);
  }, []);

  const pick = readout.pick !== undefined ? towers[readout.pick] : undefined;
  const failed = readout.failed !== undefined ? towers[readout.failed] : undefined;
  const lastIn = readout.arrived !== undefined ? towers[readout.arrived] : undefined;
  const why =
    readout.mode === "named" ? "you named it" : readout.mode === "cost" ? "cheapest per hour" : readout.mode === "value" ? "best price for its speed" : readout.mode === "failover" ? "next fastest that's up" : "fastest to ready";
  const title = readout.mode === "named" ? "Your pick" : (modes.find((m) => m.key === readout.mode)?.label ?? "");
  const comparing =
    readout.mode === "cost" ? `comparing ${towers.length} prices…` : readout.mode === "value" ? "weighing price against speed…" : readout.mode === "named" ? "going where you pointed…" : `comparing ${towers.length} start times…`;
  const sub =
    readout.phase === "idle"
      ? ""
      : readout.phase === "probing"
        ? comparing
        : readout.phase === "failed"
          ? `${failed ? short(failed.name) : ""} is down (simulated). Trying the next fastest…`
          : pick
            ? `→ ${short(pick.name)} · ${readout.mode === "cost" ? `${fmtUsd(pick.usd)}/h · ready in ${fmtMs(pick.ms)}` : `ready in ${fmtMs(pick.ms)} · ${fmtUsd(pick.usd)}/h`} · ${why}${failed ? ` · ${short(failed.name)} was down (simulated)` : ""}`
            : "";
  const chip = "cursor-pointer border px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] backdrop-blur-sm";
  const off = "border-[#f4e6c8]/25 bg-[#0c0a09]/45 text-[#f4e6c8]/80 hover:border-[#f4e6c8]/70 hover:text-[#f4e6c8]";

  return (
    <div ref={rootRef} className="relative z-50 -mt-14 h-[220vh] bg-[#0c0a09] text-[#f4e6c8]" style={{ "--p": 0 } as React.CSSProperties}>
      <div ref={hostRef} className="sticky top-0 h-screen cursor-grab overflow-hidden select-none">
        {/* Tags: one per sandbox, placed over it each frame. */}
        <div className="pointer-events-none absolute inset-0">
          {towers.map((t, i) => (
            <div
              key={t.id}
              ref={(el) => {
                tagRefs.current[i] = el;
              }}
              data-tone="idle"
              className="group absolute top-0 left-0 flex items-baseline gap-2 border border-[#f4e6c8]/20 bg-[#0c0a09]/70 px-2 py-1 whitespace-nowrap opacity-0 backdrop-blur-sm transition-opacity duration-300 data-[tone=hot]:border-[#ffe9c4] data-[tone=hot]:bg-[#ffe9c4] data-[tone=hot]:text-[#0c0a09]"
            >
              <span className="text-[12px] font-medium" />
              <span className="font-mono text-[11px] text-[#8fd0ff] group-data-[tone=down]:text-[#f4e6c8]/50 group-data-[tone=hot]:text-[#0c0a09] group-data-[tone=late]:text-[#ff8a3d]" />
            </div>
          ))}
        </div>

        {/* The demo's own controls: they fade as the copy comes in. */}
        <div className="pointer-events-none absolute inset-0" style={{ opacity: "calc(1 - var(--p) * 2)" }}>
          <header className="absolute inset-x-0 top-0 flex items-center px-5 py-5 sm:px-8">
            <Link href="/" className="pointer-events-auto inline-flex items-center gap-2 text-[15px] tracking-tight">
              <svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true">
                <path d="M1.5 11H7c3 0 3.5-7 8-7M7 11h8M7 11c3 0 3.5 7 8 7" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="square" />
                <rect x="15.5" y="2" width="4" height="4" fill="#6fc3ff" />
                <rect x="15" y="8.5" width="5" height="5" fill="#6fc3ff" />
                <rect x="15.5" y="16" width="4" height="4" fill="#6fc3ff" />
              </svg>
              sandboxRouter
            </Link>
            <div className="pointer-events-auto ml-auto flex items-center gap-1.5">
              <button onClick={toggleFollow} className={`${chip} ${follow ? "border-[#6fc3ff] bg-[#6fc3ff] text-[#0c0a09]" : off}`} title="Let the camera follow each strike down from the cloud">
                Follow strikes
              </button>
              <button onClick={() => view.current("overview")} className={`${chip} ${off}`}>
                Overview
              </button>
              <button onClick={() => view.current("out")} className={`${chip} ${off}`} aria-label="Zoom out">
                −
              </button>
              <button onClick={() => view.current("in")} className={`${chip} ${off}`} aria-label="Zoom in">
                +
              </button>
            </div>
          </header>

          <div className="absolute inset-x-0 top-[72px] flex flex-col items-center px-5 text-center" aria-live="polite">
            <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-[#f4e6c8]/55">{readout.phase === "idle" ? "sandboxRouter" : "Routing by"}</p>
            <p className="mt-1 text-[44px] leading-none sm:text-[64px]" style={{ fontFamily: "var(--font-launch-serif), Georgia, serif" }}>
              {readout.phase === "idle" ? "One API. Every sandbox." : title}
            </p>
            <p className="mt-2 min-h-[20px] font-mono text-[12.5px] text-[#f4e6c8]/85">{sub}</p>
          </div>

          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-t from-[#080605]/85 to-transparent px-5 pt-16 pb-6">
            <p className="min-h-[18px] text-center font-mono text-[12px] text-[#ff8a3d]">
              {readout.phase === "thunder" && lastIn ? `Thunder: the last to start was ${short(lastIn.name)}, ${fmtMs(lastIn.ms)}` : ""}
            </p>
            <div className="pointer-events-auto flex flex-wrap justify-center gap-1.5">
              {modes.map((m, i) => (
                <button key={m.key} onClick={() => pickMode(m.key)} className={`${chip} ${modeKey === m.key ? "border-[#ff8a3d] bg-[#ff8a3d] text-[#0c0a09]" : off}`}>
                  <span className="opacity-50">{i + 1}</span> {m.label}
                </button>
              ))}
            </div>
            <p className="text-center font-mono text-[10px] uppercase tracking-[0.14em] text-[#f4e6c8]/45">
              Drag to look around · click a sandbox to strike it · double-click to fly to it · scroll for more
            </p>
          </div>
        </div>

        {/* The copy: slides in from the left once you scroll away from the demo. */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-full bg-gradient-to-r from-[#080605] via-[#080605]/80 to-transparent sm:w-[52%]"
          style={{ opacity: "var(--p)" }}
        />
        <div
          data-panel
          className="absolute inset-y-0 left-0 flex w-full max-w-[560px] flex-col justify-center px-6 sm:px-12"
          style={{ transform: "translateX(calc((var(--p) - 1) * 60%))", opacity: "calc(var(--p) * 1.6 - 0.6)", pointerEvents: "auto" }}
        >
          <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[#f4e6c8]/65">
            Open source · {providerCount} providers · {towers.length} timed on real accounts
          </p>
          <h1 className="mt-4 text-[40px] leading-[0.98] tracking-[-0.01em] sm:text-[58px]" style={{ fontFamily: "var(--font-launch-serif), Georgia, serif" }}>
            Lightning takes the fastest path.
            <br />
            <span className="text-[#ff8a3d]">So does your code.</span>
          </h1>
          <p className="mt-5 max-w-[500px] text-[15px] leading-relaxed text-[#f4e6c8]/80">
            One API for every sandbox provider. Each run goes to the best one that&apos;s up; if it isn&apos;t, the next strike lands somewhere else. Thunder is
            everyone else, still starting.
          </p>
          <code className="mt-6 inline-block w-fit border border-[#f4e6c8]/30 bg-[#0c0a09]/50 px-3 py-2 font-mono text-[12.5px] select-text">npm i @sandboxrouter/sdk</code>
          <div className="mt-6 flex flex-wrap gap-2 font-mono text-[11px] uppercase tracking-[0.12em]">
            <Link href="/docs#quickstart" className="bg-[#ff8a3d] px-4 py-2.5 text-[#0c0a09] hover:bg-[#ffe9c4]">
              Get started ↗
            </Link>
            <Link href="/providers" className="border border-[#f4e6c8]/35 px-4 py-2.5 hover:border-[#f4e6c8]">
              Providers
            </Link>
            <Link href="/benchmarks" className="border border-[#f4e6c8]/35 px-4 py-2.5 hover:border-[#f4e6c8]">
              Benchmarks
            </Link>
          </div>
          <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.12em] text-[#f4e6c8]/45">Median start times and list prices, measured {measuredOn}</p>
        </div>
      </div>
    </div>
  );
}
