// Joint angles of a policy playing in the 3D view, relative to each joint's limits: live markers of the
// joints that move most, and per-episode ranges. Fed with one angle vector per control step (the live
// frames' tail), in the order of the hello's `joints` ({ name, range: [lo, hi] }).

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const FINGERS = { 2: "index", 3: "middle", 4: "ring", 5: "little" };
const NAMES = {
  elv_angle: "Shoulder elevation plane", shoulder_elv: "Shoulder elevation", shoulder_rot: "Shoulder rotation",
  elbow_flexion: "Elbow flexion", pro_sup: "Pronation / supination", deviation: "Wrist deviation", flexion: "Wrist flexion",
  cmc_flexion: "Thumb CMC flexion", cmc_abduction: "Thumb CMC abduction", mp_flexion: "Thumb MCP flexion", ip_flexion: "Thumb IP flexion",
};

// Readable name of a joint ("mcp2_flexion_r" -> "Index MCP flexion").
export function jointLabel(name) {
  const n = name.replace(/_r$/, "");
  if (NAMES[n]) return NAMES[n];
  const m = n.match(/^(mcp|pm|md)(\d)_(flexion|abduction)$/);
  if (!m) return name;
  const finger = FINGERS[m[2]] || m[2];
  return `${finger[0].toUpperCase() + finger.slice(1)} ${{ mcp: "MCP", pm: "PIP", md: "DIP" }[m[1]]} ${m[3]}`;
}

// An angle for display: degrees for hinges (ranges up to a few radians), metres otherwise.
const show = (v, range) => (Math.abs(range[1] - range[0]) <= 7 ? `${Math.round((v * 180) / Math.PI)}°` : v.toFixed(3));

export class JointMeter {
  constructor(joints) {
    this.joints = joints;
    this.reset();
  }

  reset() {
    const n = this.joints.length;
    this.current = new Float32Array(n);
    this.epSum = new Float64Array(n);
    this.epMin = new Float64Array(n).fill(Infinity);
    this.epMax = new Float64Array(n).fill(-Infinity);
    this.epSteps = 0;
    this.sessionSum = new Float64Array(n);  // sum over episodes of each episode's mean
    this.sesMin = new Float64Array(n).fill(Infinity);
    this.sesMax = new Float64Array(n).fill(-Infinity);
    this.episodes = 0;
    this.last = null;  // { min, max, mean } per joint of the last finished episode
    this.order = this.joints.map((_, k) => k);
  }

  // Position of angle v of joint k within its limits (0..1).
  u(k, v) {
    const [lo, hi] = this.joints[k].range;
    return hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0.5;
  }

  push(q) {
    this.current.set(q);
    for (let k = 0; k < q.length; k++) {
      this.epSum[k] += q[k];
      this.epMin[k] = Math.min(this.epMin[k], q[k]); this.epMax[k] = Math.max(this.epMax[k], q[k]);
      this.sesMin[k] = Math.min(this.sesMin[k], q[k]); this.sesMax[k] = Math.max(this.sesMax[k], q[k]);
    }
    this.epSteps++;
  }

  // Mean angle per joint: of the session, or of the running episode before the first one ends.
  get mean() {
    if (this.episodes) return this.sessionSum.map((s) => s / this.episodes);
    return this.epSum.map((s) => s / Math.max(1, this.epSteps));
  }

  endEpisode() {
    if (!this.epSteps) return;
    const mean = this.epSum.map((s) => s / this.epSteps);
    for (let k = 0; k < mean.length; k++) this.sessionSum[k] += mean[k];
    this.episodes++;
    this.last = { mean, min: Float64Array.from(this.epMin), max: Float64Array.from(this.epMax) };
    this.epSum.fill(0); this.epMin.fill(Infinity); this.epMax.fill(-Infinity);
    this.epSteps = 0;
    this.rank();
  }

  // The joints that move most first (share of their range used so far), re-ranked only between episodes.
  rank() {
    const used = this.joints.map((_, k) => (this.sesMax[k] > this.sesMin[k] ? this.u(k, this.sesMax[k]) - this.u(k, this.sesMin[k]) : 0));
    this.order = this.joints.map((_, k) => k).sort((a, b) => used[b] - used[a]);
  }

  top(n) {
    if (!this.episodes && this.epSteps % 20 === 1) this.rank();
    return this.order.slice(0, n);
  }
}

// A track over the joint's limits: the band is a range of angles, the tick the mean, the dot (live) the angle now.
function track(meter, k, lo, hi, mean, now = null) {
  const a = meter.u(k, lo), b = meter.u(k, hi), near = now != null && (meter.u(k, now) < 0.03 || meter.u(k, now) > 0.97);
  return `<span class="mbar-track jtrack"><span class="jband" style="left:${(100 * a).toFixed(1)}%;width:${(100 * Math.max(0, b - a)).toFixed(1)}%"></span><span class="mbar-tick" style="left:${(100 * meter.u(k, mean)).toFixed(1)}%"></span>${now != null ? `<span class="jdot${near ? " limit" : ""}" style="left:${(100 * meter.u(k, now)).toFixed(1)}%"></span>` : ""}</span>`;
}

// Live: the `n` joints that move most, the angle now (dot) within the limits, range used so far (band), mean (tick).
export function jointBarsHtml(meter, n) {
  const mean = meter.mean;
  return meter.top(n).map((k) => {
    const j = meter.joints[k], v = meter.current[k], label = esc(jointLabel(j.name));
    const lo = Math.min(meter.sesMin[k], v), hi = Math.max(meter.sesMax[k], v);
    return `<div class="mbar jrow" title="${label} (${esc(j.name)}): ${show(j.range[0], j.range)} to ${show(j.range[1], j.range)}"><span class="mbar-name">${label}</span>${track(meter, k, lo, hi, mean[k], v)}<span class="mbar-val mono">${show(v, j.range)}</span></div>`;
  }).join("");
}

// Per episode: the range each joint covered in the last episode (band) and the mean over the session (tick).
export function jointRangesHtml(meter, n, unit = "episode") {
  const last = meter.last;
  if (!last) return `<p class="muted mstats-empty">Joint ranges appear after the first ${unit}.</p>`;
  const mean = meter.mean;
  const rows = meter.top(n).map((k) => {
    const j = meter.joints[k], label = esc(jointLabel(j.name));
    return `<div class="mgroup jrow" title="${label}: ${show(last.min[k], j.range)} to ${show(last.max[k], j.range)} of ${show(j.range[0], j.range)} to ${show(j.range[1], j.range)}"><span class="mgroup-name">${label}</span>${track(meter, k, last.min[k], last.max[k], mean[k])}<span class="mbar-val mono">${show(last.max[k] - last.min[k], j.range)}</span></div>`;
  }).join("");
  return `<div class="mgroups"><div class="mgroup jrow mgroup-head muted"><span>Joint</span><span>last ${unit}</span><span>used</span></div>${rows}<span class="mcard-note">Band: range in the last ${unit} · <span class="tick-key"></span> mean of ${meter.episodes} · within the joint's limits</span></div>`;
}
