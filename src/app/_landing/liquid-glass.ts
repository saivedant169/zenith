"use client";
/**
 * Liquid glass for the landing's floating surfaces, ported from the reference reconstruction in
 * `Z:\Projects\Liquid Glass` (ALGORITHM.md + the demo's glass shader).
 *
 * The reference is a WebGL shader that refracts a texture it owns. Here the backdrop is live page
 * content, which no canvas can sample, so the same maths is baked per element into two images:
 *
 *  - a displacement map: rounded-rectangle signed distance → elliptical bevel profile
 *    h(s) = T·√(s(2−s)) with a weak dome → surface normal → Snell refraction through one curved
 *    interface over an effective propagation distance (path = T·2.2·refraction). Chromium applies it
 *    to the real backdrop through an SVG `feDisplacementMap` inside `backdrop-filter`, three times at
 *    the red, green and blue indices (n ∓ 0.024·dispersion) for the edge's colour separation, after
 *    a small blur for the frosted centre;
 *  - a light map: Schlick reflection towards a neutral studio environment lit from the upper left,
 *    the narrow specular lobe, the thin rim, the faint inner shadow and the restrained cyan/magenta
 *    lip, painted over the element as a background layer (every browser gets this part).
 *
 * Browsers without SVG backdrop filters (Safari, Firefox) keep a frosted `backdrop-filter: blur()`
 * with the same light map. Reduced transparency and forced colours fall back to solid surfaces in CSS.
 *
 * `tone: true` also reads what is actually behind the element (the page surfaces under a few sample
 * points) and sets `data-tone="light" | "dark"`, which swaps the landing's token set so the text on
 * the glass always contrasts with what the glass sits on.
 */
import { useEffect, type RefObject } from "react";

export interface GlassMaterial {
  /** Corner radius in CSS px, or "pill" for half the smaller side. Must match the element's CSS radius. */
  radius: number | "pill";
  /** Bevel width (the curved edge), CSS px. */
  bevel: number;
  /** Virtual thickness, CSS px. */
  thickness: number;
  ior: number;
  refraction: number;
  dispersion: number;
  /** The broad dome's share of the slope, 0–1. */
  bulge: number;
  /** Frost: blur applied to the backdrop before it is refracted, CSS px. */
  frost: number;
  /** Strength of reflections, specular, rim and lip. */
  highlight: number;
}

const BASE = { ior: 1.46, refraction: 1, dispersion: 1, bulge: 0.14, highlight: 0.9 };
export const GLASS = {
  /** Gimbal's guide: a dense reading surface, so a softer, more frosted centre. */
  panel: { ...BASE, radius: 28, bevel: 22, thickness: 20, frost: 6, bulge: 0.12 },
  /** Gimbal's small pop-outs. */
  bubble: { ...BASE, radius: 18, bevel: 14, thickness: 12, frost: 4 },
  /** The masthead: a long capsule, clearer. */
  bar: { ...BASE, radius: "pill", bevel: 16, thickness: 13, frost: 2.5, dispersion: 0.8, bulge: 0.1 },
  /** The opening's call to action: a clear lens over the sky. */
  button: { ...BASE, radius: "pill", bevel: 14, thickness: 12, frost: 0.8, refraction: 0.9, highlight: 1 },
} satisfies Record<string, GlassMaterial>;

interface Maps { displacement: HTMLCanvasElement; light: HTMLCanvasElement; scaleR: number; scaleG: number; scaleB: number }

const gauss = (x: number, w: number) => Math.exp(-(x * x) / (w * w));
const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const toSRGB = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);

/** Snell refraction of a ray looking straight in, projected onto the effective background plane. */
function refracted(nx: number, ny: number, nz: number, ior: number, path: number): [number, number] {
  const eta = 1 / Math.max(ior, 1.001);
  const cosi = nz;
  const k = 1 - eta * eta * (1 - cosi * cosi);
  if (k < 0) return [0, 0];
  const a = eta * cosi - Math.sqrt(k);
  const tx = a * nx, ty = a * ny, tz = -eta + a * nz;
  const denom = Math.max(-tz, 0.12);
  return [(tx / denom) * path, (ty / denom) * path];
}

/** The surface at one point of the slab: signed distance, outward gradient, normal. */
function surface(px: number, py: number, bx: number, by: number, r: number, m: GlassMaterial, bevel: number) {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  const len = Math.hypot(ax, ay);
  const d = Math.min(Math.max(qx, qy), 0) + len - r;
  let gx: number, gy: number;
  if (len > 1e-6) { gx = ax / len; gy = ay / len; } else if (qx > qy) { gx = 1; gy = 0; } else { gx = 0; gy = 1; }
  gx *= Math.sign(px) || 1; gy *= Math.sign(py) || 1;
  const depth = Math.max(-d, 0);
  const s = Math.min(Math.max(depth / bevel, 0.002), 1);
  const profile = Math.sqrt(Math.max(s * (2 - s), 0.001));
  const slope = (m.thickness / bevel) * (1 - s) / profile;
  // The weak broad dome, per axis so a long capsule is not dominated by it.
  const domeX = (px / bx) * 0.5 * m.bulge, domeY = (py / by) * 0.5 * m.bulge;
  let nx = gx * slope + domeX, ny = gy * slope + domeY, nz = 1;
  const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
  return { d, depth, gx, gy, nx, ny, nz };
}

function buildMaps(w: number, h: number, m: GlassMaterial, dpr: number): Maps | null {
  if (w < 8 || h < 8) return null;
  const bx = w / 2, by = h / 2;
  const r = Math.min(m.radius === "pill" ? Math.min(w, h) / 2 : m.radius, Math.min(w, h) * 0.5 - 0.01);
  const bevel = Math.max(2, Math.min(m.bevel, Math.min(w, h) * 0.45));
  const path = m.thickness * 2.2 * m.refraction;
  const chroma = m.dispersion * 0.024;

  // 1. Displacement (green index), at CSS resolution: the filter works in CSS pixels. The slab is
  //    symmetric, so one quadrant is computed and mirrored with the offsets' signs flipped.
  const W = Math.ceil(w), H = Math.ceil(h);
  const offs = new Float32Array(W * H * 2);
  let max = 0.001;
  const hx = Math.ceil(W / 2), hy = Math.ceil(H / 2);
  for (let y = 0; y < hy; y++) for (let x = 0; x < hx; x++) {
    const f = surface(x + 0.5 - W / 2, y + 0.5 - H / 2, W / 2, H / 2, r, m, bevel);
    if (f.d > 0) continue;
    const [ox, oy] = refracted(f.nx, f.ny, f.nz, m.ior, path);
    max = Math.max(max, Math.abs(ox), Math.abs(oy));
    const xs = [x, W - 1 - x], ys = [y, H - 1 - y];
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
      const i = (ys[b] * W + xs[a]) * 2;
      offs[i] = a ? -ox : ox; offs[i + 1] = b ? -oy : oy;
    }
  }
  const disp = document.createElement("canvas"); disp.width = W; disp.height = H;
  const dctx = disp.getContext("2d");
  if (!dctx) return null;
  const dimg = dctx.createImageData(W, H);
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    dimg.data[j] = Math.round(128 + (offs[i * 2] / max) * 127);
    dimg.data[j + 1] = Math.round(128 + (offs[i * 2 + 1] / max) * 127);
    dimg.data[j + 2] = 128; dimg.data[j + 3] = 255;
  }
  dctx.putImageData(dimg, 0, 0);
  // feDisplacementMap moves by scale·(C − ½), so a full-range channel spans ±max at scale 2·max.
  // The red and blue indices bend by a slightly different amount; measured at mid-bevel.
  const mid = surface(bx - bevel * 0.3, 0, bx, by, r, m, bevel);
  const g0 = Math.hypot(...refracted(mid.nx, mid.ny, mid.nz, m.ior, path)) || 1;
  const ratio = (ior: number) => Math.hypot(...refracted(mid.nx, mid.ny, mid.nz, ior, path)) / g0;
  const scaleG = 2 * max;

  // 2. Light, at up to twice the CSS resolution so the rim stays crisp on dense screens.
  const LW = Math.ceil(w * dpr), LH = Math.ceil(h * dpr);
  const light = document.createElement("canvas"); light.width = LW; light.height = LH;
  const lctx = light.getContext("2d");
  if (!lctx) return null;
  const limg = lctx.createImageData(LW, LH);
  const L = (() => { const v = [-0.48, -0.64, 0.6]; const n = Math.hypot(v[0], v[1], v[2]); return v.map((c) => c / n); })();
  const H3 = (() => { const v = [L[0], L[1], L[2] + 1]; const n = Math.hypot(v[0], v[1], v[2]); return v.map((c) => c / n); })();
  const lxy = Math.hypot(L[0], L[1]);
  const F0 = Math.pow((m.ior - 1) / (m.ior + 1), 2);
  const aa = 1 / dpr;
  const out = [0, 0, 0, 0];
  const shade = (px: number, py: number) => {
    const f = surface(px, py, bx, by, r, m, bevel);
    const lit = Math.pow(Math.max((f.gx * L[0] + f.gy * L[1]) / lxy, 0), 3);
    const F = F0 + (1 - F0) * Math.pow(1 - f.nz, 5);
    // Neutral studio environment, darker away from the bevel.
    let er = 0.11 + (0.91 - 0.11) * lit, eg = 0.13 + (0.96 - 0.13) * lit, eb = 0.17 + (1 - 0.17) * lit;
    const edge = 1 - smoothstep(0, bevel * 1.6, f.depth);
    er = 0.06 + (er - 0.06) * edge; eg = 0.085 + (eg - 0.085) * edge; eb = 0.13 + (eb - 0.13) * edge;
    let cr = toSRGB(er), cg = toSRGB(eg), cb = toSRGB(eb);
    let a = F * 0.72 * m.highlight;
    const over = (r2: number, g2: number, b2: number, a2: number) => {
      a2 = Math.min(1, Math.max(0, a2));
      const o = a2 + a * (1 - a2);
      if (o <= 0) return;
      cr = (r2 * a2 + cr * a * (1 - a2)) / o; cg = (g2 * a2 + cg * a * (1 - a2)) / o; cb = (b2 * a2 + cb * a * (1 - a2)) / o; a = o;
    };
    const inner = gauss(f.depth - bevel * 0.75, Math.max(bevel * 0.18, 1));
    over(0, 0, 0, inner * 0.035 * (1 - lit));
    const spec = Math.pow(Math.max(f.nx * H3[0] + f.ny * H3[1] + f.nz * H3[2], 0), 85);
    const rim = gauss(f.d + 0.65, 0.68 + aa * 0.45);
    const second = gauss(f.depth - 2.4, 1.4) * lit * 0.07;
    // Additive light in the reference; over a backdrop, a white layer at that alpha is its screen equivalent.
    over(1, 1, 1, (spec * 0.22 + rim * (0.14 + 0.43 * lit) + second) * m.highlight);
    const facing = Math.pow(Math.max((f.gx * 0.82 - f.gy * 0.32) / Math.hypot(0.82, 0.32), 0), 2);
    const sr = gauss(f.depth - bevel * 0.31, 1.6), sg = gauss(f.depth - bevel * 0.2, 1.4), sb = gauss(f.depth - bevel * 0.29, 2);
    const k = facing * 0.1 * m.dispersion * m.highlight;
    const peak = Math.max(sr, sg, sb);
    if (peak * k > 0.002) over(sr / peak, sg / peak, sb / peak, peak * k);
    out[0] = cr * 255; out[1] = cg * 255; out[2] = cb * 255; out[3] = a * 255;
    return out;
  };
  // Past the bevel and its inner shadow the slab is flat: one shade fills the whole interior.
  const deep = bevel * 1.6 + 4;
  const interior = shade(0, 0).slice();
  for (let y = 0; y < LH; y++) {
    const py = (y + 0.5) / dpr - by;
    for (let x = 0; x < LW; x++) {
      const px = (x + 0.5) / dpr - bx;
      const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
      const d = Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
      const mask = 1 - smoothstep(-0.6 * aa, 0.6 * aa, d);
      if (mask <= 0) continue;
      const c = -d > deep ? interior : shade(px, py);
      const j = (y * LW + x) * 4;
      limg.data[j] = c[0]; limg.data[j + 1] = c[1]; limg.data[j + 2] = c[2]; limg.data[j + 3] = c[3] * mask;
    }
  }
  lctx.putImageData(limg, 0, 0);
  return { displacement: disp, light, scaleR: scaleG * ratio(m.ior - chroma), scaleG, scaleB: scaleG * ratio(m.ior + chroma) };
}

/** PNG-encode off the main thread where the browser can, as an object URL the caller revokes. */
function objectUrl(canvas: HTMLCanvasElement): Promise<string | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), "image/png"));
}

/* ---------- The filter host: one hidden SVG with a filter per glass element. ---------- */
const SVG_NS = "http://www.w3.org/2000/svg";
let host: SVGSVGElement | null = null;
let serial = 0;
function filterHost() {
  if (host?.isConnected) return host;
  host = document.createElementNS(SVG_NS, "svg");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("width", "0"); host.setAttribute("height", "0");
  host.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  document.body.appendChild(host);
  return host;
}
function el(name: string, attrs: Record<string, string | number>, parent: Element) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent.appendChild(node);
  return node;
}
const CHANNEL = { R: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0", G: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0", B: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" };
function writeFilter(filter: SVGFilterElement, w: number, h: number, m: GlassMaterial, maps: Maps, displacement: string) {
  filter.replaceChildren();
  for (const [k, v] of Object.entries({ x: 0, y: 0, width: Math.ceil(w), height: Math.ceil(h), filterUnits: "userSpaceOnUse", primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" })) filter.setAttribute(k, String(v));
  el("feGaussianBlur", { in: "SourceGraphic", stdDeviation: m.frost, result: "soft" }, filter);
  const image = el("feImage", { x: 0, y: 0, width: Math.ceil(w), height: Math.ceil(h), preserveAspectRatio: "none", result: "map" }, filter);
  image.setAttribute("href", displacement);
  (["R", "G", "B"] as const).forEach((c) => {
    el("feDisplacementMap", { in: "soft", in2: "map", scale: (c === "R" ? maps.scaleR : c === "G" ? maps.scaleG : maps.scaleB).toFixed(2), xChannelSelector: "R", yChannelSelector: "G", result: `d${c}` }, filter);
    el("feColorMatrix", { in: `d${c}`, type: "matrix", values: CHANNEL[c], result: `c${c}` }, filter);
  });
  el("feBlend", { in: "cR", in2: "cG", mode: "screen", result: "rg" }, filter);
  el("feBlend", { in: "rg", in2: "cB", mode: "screen", result: "rgb" }, filter);
  el("feColorMatrix", { in: "rgb", type: "saturate", values: 1.25 }, filter);
}

/** Chromium applies SVG filters to the backdrop; Safari and Firefox do not (they keep the frosted fallback). */
function lensSupported() {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  return Boolean(brands?.some((b) => /Chromium/i.test(b.brand)));
}

/* ---------- Tone: what is the glass actually sitting on? ---------- */
function parseColor(value: string): { r: number; g: number; b: number; a: number } | null {
  const nums = value.match(/-?[\d.]+/g)?.map(Number);
  if (!nums || nums.length < 3) return null;
  if (value.startsWith("color(")) return { r: nums[0], g: nums[1], b: nums[2], a: nums[3] ?? 1 };
  return { r: nums[0] / 255, g: nums[1] / 255, b: nums[2] / 255, a: nums[3] ?? 1 };
}
const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function luminanceAt(x: number, y: number, self: Element): number {
  for (const node of document.elementsFromPoint(x, y)) {
    if (self.contains(node) || node.closest("[data-glass-skip]")) continue;
    // The opening is a painted sky (canvas, gradients, ridges): dark wherever the glass can sit on it.
    if (node.closest(".zenith-hero")) return 0.05;
    const color = parseColor(getComputedStyle(node).backgroundColor);
    if (color && color.a > 0.5) return luminance(color);
  }
  const page = parseColor(getComputedStyle(document.body).backgroundColor);
  return page && page.a > 0.5 ? luminance(page) : 0.9;
}

function readTone(target: HTMLElement, previous: string | undefined): "light" | "dark" {
  const box = target.getBoundingClientRect();
  if (!box.width || !box.height) return (previous as "light" | "dark") ?? "dark";
  const xs = [0.18, 0.5, 0.82], ys = box.height > 90 ? [0.2, 0.5, 0.8] : [0.5];
  let sum = 0, n = 0;
  for (const fx of xs) for (const fy of ys) {
    const x = box.left + box.width * fx, y = box.top + box.height * fy;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    sum += luminanceAt(x, y, target); n++;
  }
  if (!n) return (previous as "light" | "dark") ?? "dark";
  const lum = sum / n;
  // Hysteresis, so the text does not flicker at a boundary between two surfaces.
  if (previous === "light") return lum < 0.3 ? "dark" : "light";
  if (previous === "dark") return lum > 0.45 ? "light" : "dark";
  return lum > 0.38 ? "light" : "dark";
}

/**
 * Make `ref` a liquid-glass surface. `active` re-runs the setup when a conditionally rendered
 * element mounts (Gimbal's panel and pop-outs); `tone` keeps `data-tone` in step with the backdrop.
 */
export function useLiquidGlass(ref: RefObject<HTMLElement | null>, material: GlassMaterial, { active = true, tone = false }: { active?: boolean; tone?: boolean } = {}) {
  useEffect(() => {
    const target = ref.current;
    if (!active || !target || typeof window === "undefined" || typeof ResizeObserver === "undefined" || typeof window.matchMedia !== "function") return;
    const lens = lensSupported() && !window.matchMedia("(prefers-reduced-transparency: reduce)").matches && !window.matchMedia("(forced-colors: active)").matches;
    const id = `zenith-glass-${++serial}`;
    const filter = lens ? (el("filter", { id }, filterHost()) as SVGFilterElement) : null;
    let size = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | null = null;
    let disposed = false;

    let generation = 0;
    let urls: string[] = [];
    const release = () => { urls.forEach((url) => URL.revokeObjectURL(url)); urls = []; };

    const build = async () => {
      if (disposed) return;
      const w = target.offsetWidth, h = target.offsetHeight;
      const key = `${w}x${h}`;
      if (key === size) return;
      size = key;
      const mine = ++generation;
      // The element's own corner (it can differ by breakpoint) decides the lens's corner; "pill" resolves the same way.
      const css = parseFloat(getComputedStyle(target).borderTopLeftRadius);
      const shape = Number.isFinite(css) && css > 0 ? { ...material, radius: css } : material;
      const started = performance.now();
      const maps = buildMaps(w, h, shape, Math.min(2, window.devicePixelRatio || 1));
      performance.measure(`zenith-glass ${w}x${h}`, { start: started, end: performance.now() });
      if (!maps) return;
      const [displacement, light] = await Promise.all([filter ? objectUrl(maps.displacement) : Promise.resolve(null), objectUrl(maps.light)]);
      if (disposed || mine !== generation || !light || (filter && !displacement)) {
        [displacement, light].forEach((url) => url && URL.revokeObjectURL(url));
        return;
      }
      release();
      urls = [light, ...(displacement ? [displacement] : [])];
      target.style.setProperty("--lg-light", `url("${light}")`);
      if (filter && displacement) {
        writeFilter(filter, w, h, shape, maps, displacement);
        target.style.setProperty("backdrop-filter", `url(#${id})`);
        target.dataset.glass = "lens";
      } else target.dataset.glass = "frost";
    };
    // The first build waits for a quiet moment, so it never competes with the page's first paint;
    // until then the CSS draws the same surface frosted.
    const idle = typeof window.requestIdleCallback === "function";
    const first = idle ? window.requestIdleCallback(() => void build(), { timeout: 900 }) : window.setTimeout(() => void build(), 200);
    const resize = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(() => void build(), 120); });
    resize.observe(target);

    const retone = () => {
      frame = null;
      if (disposed) return;
      const next = readTone(target, target.dataset.tone);
      if (next !== target.dataset.tone) target.dataset.tone = next;
    };
    const schedule = () => { if (!disposed && frame === null) frame = requestAnimationFrame(retone); };
    let settle: ReturnType<typeof setTimeout> | undefined;
    if (tone) {
      schedule();
      // Once more after the entrance and reveal animations have placed what sits behind.
      settle = setTimeout(schedule, 700);
      window.addEventListener("scroll", schedule, { passive: true });
      window.addEventListener("resize", schedule);
    }
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(settle);
      if (frame !== null) cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (idle) window.cancelIdleCallback(first); else clearTimeout(first);
      release();
      filter?.remove();
      target.style.removeProperty("--lg-light");
      target.style.removeProperty("backdrop-filter");
      delete target.dataset.glass;
    };
  }, [ref, material, active, tone]);
}
