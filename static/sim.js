// An example policy running in the page: MuJoCo (WebAssembly) steps the task's physics model and a
// small MLP picks the muscle excitations. Mirrors studio/browser.py's Reference step for step.

const sigmoid = (a) => 1 / (1 + Math.exp(-5 * (a - 0.5)));

export class TaskSim {
  // base: folder of an example (sim.json, sim_model.xml, sim_policy.bin); mujocoUrl: the vendored module.
  static async load(base, mujocoUrl = new URL("./vendor/mujoco/mujoco.js", import.meta.url).href) {
    const [{ default: loadMujoco }, info] = await Promise.all([import(mujocoUrl), fetch(`${base}/sim.json`).then((r) => r.json())]);
    const [mujoco, xml, weights] = await Promise.all([
      TaskSim.runtime || (TaskSim.runtime = loadMujoco()),
      fetch(`${base}/${info.model}`).then((r) => r.text()),
      fetch(`${base}/${info.policy}`).then((r) => r.arrayBuffer()),
    ]);
    return new TaskSim(mujoco, info, xml, new Float32Array(weights));
  }

  constructor(mujoco, info, xml, weights) {
    this.mj = mujoco;
    this.info = info;
    this.task = info.task;
    const m = (this.model = mujoco.MjModel.from_xml_string(xml));
    this.data = new mujoco.MjData(m);
    const id = (kind, name) => {
      const i = mujoco.mj_name2id(m, kind.value, name);
      if (i < 0) throw new Error(`the model has no ${name}`);
      return i;
    };
    const joints = this.task.joints.map((n) => id(mujoco.mjtObj.mjOBJ_JOINT, n));
    this.qadr = joints.map((j) => m.jnt_qposadr[j]);
    this.vadr = joints.map((j) => m.jnt_dofadr[j]);
    this.range = joints.map((j) => [m.jnt_range[2 * j], m.jnt_range[2 * j + 1]]);
    this.site = id(mujoco.mjtObj.mjOBJ_SITE, this.task.ee_site);
    // per target: its body and geom, and for a button the address of its touch sensor's reading
    this.targets = this.task.targets.map((t) => ({
      ...t,
      bodyId: id(mujoco.mjtObj.mjOBJ_BODY, t.body),
      geomId: id(mujoco.mjtObj.mjOBJ_GEOM, t.geom),
      sensorAdr: t.sensor ? m.sensor_adr[id(mujoco.mjtObj.mjOBJ_SENSOR, t.sensor)] : -1,
    }));
    // actor: observation mean and std, then (weight, bias) per layer
    const n = info.network.obs;
    this.mean = weights.subarray(0, n);
    this.std = weights.subarray(n, 2 * n);
    let at = 2 * n;
    this.layers = info.network.layers.map(([nIn, nOut]) => {
      const layer = { nIn, nOut, w: weights.subarray(at, at + nIn * nOut), b: weights.subarray(at + nIn * nOut, at + nIn * nOut + nOut) };
      at += nIn * nOut + nOut;
      return layer;
    });
    this.obs = new Float32Array(n);
    this.current = 0;  // index of the target the policy is on
    this.inside = 0;
    this.steps = 0;
    this.reset();
  }

  // A start and targets as training draws them (every axis on its own), or the given ones:
  // joint offsets (rad) and velocities, and per target a world position and a size (3 numbers).
  reset({ jointOffset, jointVel, positions, sizes } = {}) {
    const { mj, model: m, data: d, task } = this;
    const r = task.reset_offset, uni = (lo, hi) => lo + Math.random() * (hi - lo);
    jointOffset = jointOffset || this.qadr.map(() => uni(-r, r));
    jointVel = jointVel || this.qadr.map(() => uni(-r, r));
    positions = positions || this.targets.map((t) => task.origin.map((o, k) => o + uni(t.position[0][k], t.position[1][k])));
    sizes = sizes || this.targets.map((t) => [0, 1, 2].map((k) => uni(t.size[0][k], t.size[1][k])));
    mj.mj_resetData(m, d);
    this.qadr.forEach((a, k) => { d.qpos[a] = Math.min(this.range[k][1], Math.max(this.range[k][0], m.qpos0[a] + jointOffset[k])); });
    this.vadr.forEach((a, k) => { d.qvel[a] = jointVel[k]; });
    this.targets.forEach((t, i) => {
      for (let k = 0; k < 3; k++) { m.body_pos[3 * t.bodyId + k] = positions[i][k]; m.geom_size[3 * t.geomId + k] = sizes[i][k]; }
    });
    mj.mj_forward(m, d);
    this.current = 0;
    this.inside = 0;
    this.steps = 0;
  }

  observe() {
    const { model: m, data: d, obs } = this;
    let at = 0;
    const nj = this.qadr.length;
    for (let k = 0; k < nj; k++) {
      const [lo, hi] = this.range[k];
      obs[k] = ((d.qpos[this.qadr[k]] - lo) / (hi - lo) - 0.5) * 2;
      obs[nj + k] = d.qvel[this.vadr[k]];
      obs[2 * nj + k] = d.qacc[this.vadr[k]];
    }
    at = 3 * nj;
    for (let k = 0; k < m.na; k++) obs[at++] = (d.act[k] - 0.5) * 2;
    for (let k = 0; k < 3; k++) obs[at++] = d.site_xpos[3 * this.site + k];
    const n = this.targets.length, t = this.targets[Math.min(this.current, n - 1)];
    for (let k = 0; k < 3; k++) obs[at++] = d.xipos[3 * t.bodyId + k];
    for (let k = 0; k < 3; k++) obs[at++] = m.geom_size[3 * t.geomId + k];
    obs[at++] = -1 + 2 * this.current / n;
    obs[at++] = -1 + 2 * (t.dwell_steps > 0 ? this.inside / Math.max(t.dwell_steps, 1) : 0);
    return obs;
  }

  act(obs) {
    let x = new Float32Array(obs.length);
    for (let k = 0; k < obs.length; k++) x[k] = (obs[k] - this.mean[k]) / this.std[k];
    this.layers.forEach(({ nIn, nOut, w, b }, l) => {
      const y = new Float32Array(nOut), last = l === this.layers.length - 1;
      for (let i = 0; i < nOut; i++) {
        let s = b[i];
        for (let j = 0, row = i * nIn; j < nIn; j++) s += w[row + j] * x[j];
        y[i] = last || s > 0 ? s : Math.expm1(s);
      }
      x = y;
    });
    return x;
  }

  // One control step of the policy; true once every target is done.
  step() {
    const { mj, model: m, data: d, task } = this;
    const action = this.act(this.observe());
    for (let k = 0; k < m.nu; k++) d.ctrl[k] = sigmoid(action[k]);
    for (let k = 0; k < task.substeps; k++) mj.mj_step(m, d);
    const n = this.targets.length, t = this.targets[Math.min(this.current, n - 1)];
    let dist = 0;
    for (let k = 0; k < 3; k++) dist += (d.site_xpos[3 * this.site + k] - d.xipos[3 * t.bodyId + k]) ** 2;
    if (Math.sqrt(dist) < m.geom_size[3 * t.geomId]) this.inside++;
    // a sphere counts once the fingertip dwelt inside, a button once its touch sensor reads the force
    const pressed = t.sensorAdr < 0 || d.sensordata[t.sensorAdr] >= t.min_force;
    if (this.inside >= t.dwell_steps && pressed) { this.current++; this.inside = 0; }
    this.steps++;
    return this.current >= n;
  }

  get timedOut() { return this.steps >= this.task.max_steps; }

  // The scene's live frame: per body position (3), then orientation (w, x, y, z), then each target's position.
  frame() {
    const { model: m, data: d } = this, nb = m.nbody;
    const f = new Float32Array(7 * nb + 3 * this.targets.length);
    f.set(d.xpos.subarray(0, 3 * nb), 0);
    f.set(d.xquat.subarray(0, 4 * nb), 3 * nb);
    this.targets.forEach((t, i) => f.set(d.xipos.subarray(3 * t.bodyId, 3 * t.bodyId + 3), 7 * nb + 3 * i));
    return f;
  }

  dispose() { this.data.delete(); this.model.delete(); }
}
