// Studio's 3D scene: the body model (geometry exported from MuJoCo, see studio/scene.py), the
// target regions with drag handles, an optional screen (e.g. a Figma frame) and the live feed of a
// policy. Everything inside `world` is in MuJoCo's frame (x forward, y left, z up, metres); the
// page talks to the scene through methods and the events "select", "change", "add",
// "screen-change" and "status".
import * as THREE from "./vendor/three/three.module.min.js";
import { OrbitControls } from "./vendor/three/addons/OrbitControls.js";
import { TransformControls } from "./vendor/three/addons/TransformControls.js";

const MJ_QUAT = (q) => new THREE.Quaternion(q[1], q[2], q[3], q[0]); // MuJoCo w, x, y, z -> three
const STEP = 0.005; // 5 mm grid of the target ranges
const snap = (v) => Math.round(v / STEP) * STEP;
const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export class StudioScene extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
    this.world = new THREE.Group();
    this.world.rotation.x = -Math.PI / 2; // MuJoCo z-up inside, three y-up outside
    this.scene.add(this.world);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f9c, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(2, 4, 3);
    this.scene.add(sun);
    this.grid = new THREE.GridHelper(4, 40);
    this.scene.add(this.grid);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace("local");
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener("dragging-changed", (e) => { this.controls.enabled = !e.value; });
    this.gizmo.addEventListener("objectChange", () => this._onGizmo());
    // A resize is relative to the region's size when the drag started.
    this.gizmo.addEventListener("mouseDown", () => { const o = this.gizmo.object; if (o && o.userData.ext) o.userData.ext0 = [...o.userData.ext]; });
    this.gizmo.addEventListener("mouseUp", () => {
      const o = this.gizmo.object;
      if (!o || !o.userData.ext0) return;
      delete o.userData.ext0;
      o.scale.set(1, 1, 1);
      o.userData.marker.scale.set(1, 1, 1);
      o.userData.region.scale.set(...o.userData.ext.map((x) => Math.max(x, 0.002)));
    });
    this.scene.add(this.gizmo.getHelper());

    this.models = new Map(); // name -> { json, buffer }
    this.bodies = []; // body groups of the shown model, by body index
    this.bodyByName = new Map();
    this.origin = new THREE.Vector3(); // shoulder (target origin), MuJoCo frame
    this.targetGroup = new THREE.Group();
    this.liveGroup = new THREE.Group();
    this.world.add(this.targetGroup, this.liveGroup);
    this.targets = [];
    this.selected = null;
    this.editable = true;
    this.live = null;
    this.screen = null;
    this.hover = null; // pointer on the plane through the shoulder that faces the camera
    this._raycaster = new THREE.Raycaster();
    this._bindPointer();
    this._theme();
    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();
    const loop = () => { requestAnimationFrame(loop); if (!document.hidden) { this.controls.update(); this._updateMuscles(); this.renderer.render(this.scene, this.camera); } };
    loop();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => this._theme());
    new MutationObserver(() => this._theme()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _theme() {
    this.scene.background = new THREE.Color(css("--scene-bg", "#e9ecf2"));
    const line = new THREE.Color(css("--scene-grid", "#c9ceda"));
    this.grid.material.color = line;
    this.grid.material.opacity = 0.6;
    this.grid.material.transparent = true;
    if (this._reach) this._reach.material.color = new THREE.Color(css("--scene-reach", "#8a90a6"));
  }

  _resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Centre the view in the free space between the overlaid panels (picking follows the offset).
    if (this.focus) this.camera.setViewOffset(w, h, w / 2 - (this.focus[0] + this.focus[1]) / 2, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  // Free horizontal span of the canvas (CSS pixels from its left edge), or null for the whole width.
  setFocus(span) {
    const same = span && this.focus && Math.abs(span[0] - this.focus[0]) < 1 && Math.abs(span[1] - this.focus[1]) < 1;
    if (same || (!span && !this.focus)) return;
    this.focus = span;
    this._resize();
  }

  // ------------------------------------------------------------------ body model
  async loadModel(name, base = "") {
    if (this.modelName === name && this.bodies.length) return;
    this.modelName = name;
    let entry = this.models.get(name);
    if (!entry) {
      const json = await fetch(`${base}scenes/${name}.json`).then((r) => { if (!r.ok) throw new Error(`no scene for ${name}`); return r.json(); });
      // The backend sends the mesh buffer as binary; static copies of the page ship it as base64 text.
      const res = await fetch(`${base}scenes/${json.buffer}`);
      if (!res.ok) throw new Error(`no meshes for ${name}`);
      const buffer = json.buffer.endsWith(".b64.txt") ? Uint8Array.from(atob(await res.text()), (c) => c.charCodeAt(0)).buffer : await res.arrayBuffer();
      entry = { json, buffer };
      this.models.set(name, entry);
    }
    if (this.modelName !== name) return; // another model was asked for meanwhile
    this._buildModel(entry.json, entry.buffer);
  }

  _buildModel(sc, buffer) {
    for (const b of this.bodies) this.world.remove(b);
    this.bodies = [];
    this.bodyByName.clear();
    this.sceneInfo = sc;
    const Index = sc.index_type === "uint32" ? Uint32Array : Uint16Array;
    const meshGeoms = sc.meshes.map((m) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buffer, m.vert[0], m.vert[1] * 3), 3));
      g.setIndex(new THREE.BufferAttribute(new Index(buffer, m.face[0], m.face[1] * 3), 1));
      g.computeVertexNormals();
      return g;
    });
    sc.bodies.forEach((b) => {
      const grp = new THREE.Group();
      grp.name = b.name;
      grp.userData.rest = { pos: b.pos, quat: b.quat };
      grp.position.fromArray(b.pos);
      grp.quaternion.copy(MJ_QUAT(b.quat));
      this.world.add(grp);
      this.bodies.push(grp);
      this.bodyByName.set(b.name, grp);
    });
    for (const g of sc.geoms) {
      const geo = g.type === "mesh" ? meshGeoms[g.mesh] : primitive(g);
      if (!geo) continue;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(g.rgba[0], g.rgba[1], g.rgba[2]), roughness: 0.65, metalness: 0.0,
        transparent: g.rgba[3] < 1, opacity: g.rgba[3],
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.fromArray(g.pos);
      mesh.quaternion.copy(MJ_QUAT(g.quat));
      if (g.type === "capsule" || g.type === "cylinder") mesh.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
      mesh.userData.body = true;
      mesh.userData.volume = !!g.volume;
      if (g.volume) mesh.visible = this.showSkin !== false;
      this.bodies[g.body].add(mesh);
    }
    this._buildMuscles(sc.muscles || []);
    this.origin.fromArray(sc.origin);
    this.grid.position.set(0, 0, 0);
    this._buildReach(sc.reach);
    this.targetGroup.position.copy(this.origin); // targets are relative to the shoulder
    this.liveGroup.position.set(0, 0, 0);
    if (!this._viewSet) this.setView("perspective");
    this._emit("model", { name: sc.model });
  }

  _buildReach(radius) {
    if (this._reach) this.world.remove(this._reach), this.world.remove(this._shoulder);
    const geo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(radius, 3));
    this._reach = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: css("--scene-reach", "#8a90a6"), transparent: true, opacity: 0.18 }));
    this._reach.position.copy(this.origin);
    this._reach.visible = this.showReach !== false;
    this._shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), new THREE.MeshBasicMaterial({ color: css("--accent", "#c2412d") }));
    this._shoulder.position.copy(this.origin);
    this.world.add(this._reach, this._shoulder);
  }

  setReachVisible(on) { this.showReach = on; if (this._reach) this._reach.visible = on; }

  // ------------------------------------------------------------------ muscles
  // Every muscle is drawn site to site as thin cylinders; the sites ride on their bodies, so the paths
  // follow the pose (also in the live view). One instanced mesh holds all segments.
  _buildMuscles(muscles) {
    if (this._muscles) { this.world.remove(this._muscles); this._muscles.geometry.dispose(); this._muscles = null; }
    this._segments = [];
    for (const m of muscles) {
      for (let k = 1; k < m.points.length; k++) this._segments.push([m.points[k - 1], m.points[k], m.radius]);
    }
    if (!this._segments.length) return;
    const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);  // unit cylinder along y, scaled per segment
    const mat = new THREE.MeshStandardMaterial({ color: css("--scene-muscle", "#c4473d"), roughness: 0.55 });
    this._muscles = new THREE.InstancedMesh(geo, mat, this._segments.length);
    this._muscles.frustumCulled = false;
    this._muscles.visible = this.showMuscles !== false;
    this.world.add(this._muscles);
    this._updateMuscles(true);
  }

  setMusclesVisible(on) { this.showMuscles = on; if (this._muscles) this._muscles.visible = on; }

  // The skin: the body volumes around the bones (primitive geoms, e.g. the MoBL arm's capsules).
  setSkinVisible(on) {
    this.showSkin = on;
    for (const b of this.bodies) b.traverse((o) => { if (o.userData.volume) o.visible = on; });
  }
  get hasSkin() { return (this.sceneInfo?.geoms || []).some((g) => g.volume); }

  _updateMuscles(force = false) {
    if (!this._muscles || (!this._muscles.visible && !force)) return;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), dir = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion(), m = new THREE.Matrix4(), scale = new THREE.Vector3();
    const at = (p, out) => { const body = this.bodies[p[0]]; return out.set(p[1], p[2], p[3]).applyQuaternion(body.quaternion).add(body.position); };
    this._segments.forEach(([p0, p1, r], i) => {
      at(p0, a); at(p1, b);
      dir.subVectors(b, a);
      const len = dir.length();
      q.setFromUnitVectors(up, len > 1e-9 ? dir.divideScalar(len) : up);
      m.compose(a.add(b).multiplyScalar(0.5), q, scale.set(r, len, r));
      this._muscles.setMatrixAt(i, m);
    });
    this._muscles.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ cameras
  _toThree(v) { this.world.updateMatrixWorld(); return this.world.localToWorld(v.clone()); }

  setView(kind) {
    this._viewSet = true;
    const o = this.origin.clone();
    let eye, look = o.clone(), up = new THREE.Vector3(0, 0, 1), fov = 40;
    if (kind === "top") { eye = o.clone().add(new THREE.Vector3(0.3, 0, 2.4)); look = o.clone().add(new THREE.Vector3(0.3, 0, 0)); up = new THREE.Vector3(1, 0, 0); }
    else if (kind === "side") { eye = o.clone().add(new THREE.Vector3(0.3, -2.4, 0)); look = o.clone().add(new THREE.Vector3(0.3, 0, 0)); }
    else if (kind === "user") {
      const cam = (this.sceneInfo?.cameras || []).find((c) => c.name === "fixed-eye") || this.sceneInfo?.cameras?.[0];
      if (cam) {
        const m = cam.mat; // row-major 3x3; columns are camera x, y, z (z points backwards)
        eye = new THREE.Vector3(...cam.pos);
        look = eye.clone().sub(new THREE.Vector3(m[2], m[5], m[8]).multiplyScalar(0.6));
        up = new THREE.Vector3(m[1], m[4], m[7]);
        fov = Math.min(100, cam.fovy);
      }
    }
    // Default: over the right shoulder, so screens and targets face the viewer as they face the user.
    if (!eye) { eye = o.clone().add(new THREE.Vector3(-1.05, -1.45, 0.75)); look = o.clone().add(new THREE.Vector3(0.3, 0.05, -0.2)); }
    this.camera.position.copy(this._toThree(eye));
    this.camera.up.copy(up.applyQuaternion(this.world.quaternion));
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(this._toThree(look));
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  // ------------------------------------------------------------------ targets (relative to the shoulder)
  setTargets(targets, selected) {
    this.targetData = targets;
    while (this.targetGroup.children.length) this.targetGroup.remove(this.targetGroup.children[0]);
    this.targets = targets.map((t, i) => this._buildTarget(t, i));
    this.select(selected ?? null, true);
  }

  _buildTarget(t, i) {
    const grp = new THREE.Group();
    const color = new THREE.Color(t.color);
    const lo = (r) => Math.min(...r), hi = (r) => Math.max(...r), mid = (r) => (lo(r) + hi(r)) / 2;
    grp.position.set(mid(t.x), mid(t.y), mid(t.z));
    const ext = [t.x, t.y, t.z].map((r) => hi(r) - lo(r));
    // The region: where the target centre is drawn each episode (a proxy the handles move and scale).
    const region = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false }));
    region.scale.set(...ext.map((e) => Math.max(e, 0.002)));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color }));
    region.add(edges);
    region.userData.target = i;
    grp.add(region);
    let marker;
    if (t.type === "Button") {
      marker = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.012), new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
    } else {
      const r = Math.max(...t.size);
      marker = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.55, roughness: 0.4 }));
      const minR = Math.min(...t.size);
      if (minR < r) marker.add(new THREE.Mesh(new THREE.SphereGeometry(minR, 24, 12), new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.5 })));
    }
    marker.userData.target = i;
    grp.add(marker);
    grp.add(label(String(i + 1), t.color));
    grp.userData = { i, region, marker, ext };
    this.targetGroup.add(grp);
    return grp;
  }

  select(i, silent = false) {
    this.selected = i;
    this.gizmo.detach();
    this.targets.forEach((g, k) => { g.userData.region.material.opacity = k === i ? 0.22 : 0.12; });
    if (i != null && this.targets[i] && this.editable) this._attachTarget(i);
    else if (i === "screen" && this.screen && this.editable) { this.gizmo.attach(this.screen); this.gizmo.setMode(this.mode === "rotate" ? "rotate" : "translate"); }
    if (!silent) this._emit("select", { i });
  }

  _attachTarget(i) {
    const g = this.targets[i];
    // The handles act on the whole target group: translate moves the region, scale resizes it.
    g.scale.set(1, 1, 1);
    this.gizmo.attach(g);
    this.gizmo.setMode(this.mode === "scale" ? "scale" : "translate");
  }

  setMode(mode) {
    this.mode = mode;
    if (this.selected === "screen") this.gizmo.setMode(mode === "rotate" ? "rotate" : "translate");
    else if (this.selected != null) this.gizmo.setMode(mode === "scale" ? "scale" : "translate");
  }

  _onGizmo() {
    const obj = this.gizmo.object;
    if (!obj) return;
    if (obj === this.screen) { this._emit("screen-change", this.screenPose()); return; }
    const { i } = obj.userData;
    const ext = obj.userData.ext0 || obj.userData.ext;
    const t = this.targetData[i];
    const c = obj.position;
    // Scaling stretches the region (never the marker), from at least one grid step.
    const e = ext.map((x, k) => (obj.scale.getComponent(k) === 1 ? x : Math.max(0, snap(Math.max(x, STEP) * obj.scale.getComponent(k)))));
    const range = (centre, extent) => [snap(centre - extent / 2), snap(centre + extent / 2)].map((v) => Math.round(v * 1000) / 1000);
    t.x = range(c.x, e[0]); t.y = range(c.y, e[1]); t.z = range(c.z, e[2]);
    if (this.gizmo.mode === "scale") {
      obj.userData.ext = e;
      obj.userData.region.scale.set(...e.map((x) => Math.max(x, 0.002)));
      // Undo the group's stretch on the marker and label; the handles keep their own scale.
      obj.userData.marker.scale.set(...[0, 1, 2].map((k) => 1 / obj.scale.getComponent(k)));
      obj.userData.region.scale.divide(obj.scale);
    }
    this._emit("change", { i, target: t });
  }

  // ------------------------------------------------------------------ pointer: select, add, hover
  _bindPointer() {
    const el = this.renderer.domElement;
    const ndc = (ev) => { const r = el.getBoundingClientRect(); return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1); };
    let down = null;
    el.addEventListener("pointerdown", (ev) => { down = [ev.clientX, ev.clientY]; });
    el.addEventListener("pointermove", (ev) => { this.hover = this._planePoint(ndc(ev)); });
    el.addEventListener("pointerleave", () => { this.hover = null; });
    el.addEventListener("pointerup", (ev) => {
      if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 4 || this.gizmo.dragging || !this.editable) return;
      this._raycaster.setFromCamera(ndc(ev), this.camera);
      const pick = [...this.targetGroup.children, ...(this.screen ? [this.screen] : [])];
      // The ray hits the screen's image plane, a child of the screen frame.
      const onScreen = (o) => !!this.screen && (o === this.screen || o.parent === this.screen);
      const hit = this._raycaster.intersectObjects(pick, true).find((h) => h.object.userData.target != null || onScreen(h.object));
      if (hit) this.select(onScreen(hit.object) ? "screen" : hit.object.userData.target);
      else if (this.selected != null) this.select(null);
    });
    el.addEventListener("dblclick", (ev) => {
      if (!this.editable) return;
      const p = this._planePoint(ndc(ev));
      if (p) this._emit("add", { pos: p });
    });
  }

  // Point under the pointer on the plane through the shoulder facing the camera, relative to the shoulder.
  _planePoint(v) {
    if (!this.bodies.length) return null;
    this._raycaster.setFromCamera(v, this.camera);
    const o = this._toThree(this.origin);
    const n = new THREE.Vector3().subVectors(this.camera.position, o).normalize();
    const hit = this._raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, o), new THREE.Vector3());
    if (!hit) return null;
    const local = this.world.worldToLocal(hit).sub(this.origin);
    return [snap(local.x), snap(local.y), snap(local.z)];
  }

  setEditable(on) {
    const was = this.editable;
    this.editable = on;
    if (!on) this.gizmo.detach();
    else if (!was) this.select(this.selected, true); // handles back on the selected target
  }

  // Move the target groups to their current ranges (no rebuild: a drag on the screen keeps going).
  moveTargets() {
    const mid = (r) => (Math.min(...r) + Math.max(...r)) / 2;
    this.targets.forEach((g, i) => { const t = this.targetData[i]; g.position.set(mid(t.x), mid(t.y), mid(t.z)); });
  }

  // ------------------------------------------------------------------ screen (e.g. a Figma frame)
  // Pose relative to the shoulder; the image faces the user (normal -x), its left edge on the user's left (+y).
  setScreen(sc) {
    if (this.screen) { this.gizmo.detach(); this.targetGroup.remove(this.screen); this.screen = null; }
    if (!sc) return;
    const tex = new THREE.TextureLoader().load(sc.image);
    tex.colorSpace = THREE.SRGBColorSpace;
    const h = sc.widthM * (sc.height / sc.width);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(sc.widthM, h), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    const frame = new THREE.Group();
    frame.add(plane);
    frame.position.fromArray(sc.pos);
    frame.quaternion.fromArray(sc.quat || [0, 0, 0, 1]);
    plane.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));
    frame.userData = { ...sc, plane };
    this.screen = frame;
    this.targetGroup.add(frame);
  }

  screenPose() {
    if (!this.screen) return null;
    return { pos: this.screen.position.toArray().map((v) => Math.round(v * 1000) / 1000), quat: this.screen.quaternion.toArray() };
  }

  // Shoulder-relative centre of a screen element (pixel box) and its half size in metres.
  screenElement(el) {
    const s = this.screen.userData;
    const m = s.widthM / s.width;
    const u = (el.x + el.w / 2 - s.width / 2) * m, v = (s.height / 2 - (el.y + el.h / 2)) * m;
    const p = new THREE.Vector3(u, v, 0).applyQuaternion(s.plane.quaternion).applyQuaternion(this.screen.quaternion).add(this.screen.position);
    return { pos: p.toArray().map((x) => Math.round(x * 1000) / 1000), half: (Math.min(el.w, el.h) / 2) * m };
  }

  // ------------------------------------------------------------------ live feed
  // hello: { bodies: [names], targets: [{ rgba, radius }] }; then frames from applyFrame.
  setLive(hello) {
    this.live = hello;
    while (this.liveGroup.children.length) this.liveGroup.remove(this.liveGroup.children[0]);
    this.targetGroup.visible = !hello;
    if (!hello) {
      this.bodies.forEach((b) => { b.position.fromArray(b.userData.rest.pos); b.quaternion.copy(MJ_QUAT(b.userData.rest.quat)); });
      return;
    }
    this.setEditable(false);
    hello.map = hello.bodies.map((n) => this.bodyByName.get(n) || null);
    hello.targetMeshes = hello.targets.map((t) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(Math.max(t.radius, 0.005), 32, 16), new THREE.MeshStandardMaterial({ color: new THREE.Color(t.rgba[0], t.rgba[1], t.rgba[2]), transparent: true, opacity: 0.8 }));
      this.liveGroup.add(m);
      return m;
    });
  }

  applyFrame(f) {
    const L = this.live;
    if (!L) return;
    const nb = L.bodies.length;
    for (let b = 0; b < nb; b++) {
      const g = L.map[b];
      if (!g) continue;
      g.position.set(f[3 * b], f[3 * b + 1], f[3 * b + 2]);
      const q = 3 * nb + 4 * b;
      g.quaternion.set(f[q + 1], f[q + 2], f[q + 3], f[q]);
    }
    const t0 = 7 * nb;
    L.targetMeshes.forEach((m, k) => m.position.set(f[t0 + 3 * k], f[t0 + 3 * k + 1], f[t0 + 3 * k + 2]));
  }

  // ------------------------------------------------------------------ export
  async exportGLB() {
    const { GLTFExporter } = await import("./vendor/three/addons/GLTFExporter.js");
    const helperVisible = this.gizmo.getHelper().visible;
    this.gizmo.getHelper().visible = false;
    try {
      const glb = await new GLTFExporter().parseAsync(this.world, { binary: true, onlyVisible: true });
      return new Blob([glb], { type: "model/gltf-binary" });
    } finally {
      this.gizmo.getHelper().visible = helperVisible;
    }
  }
}

function primitive(g) {
  const s = g.size;
  if (g.type === "sphere") return new THREE.SphereGeometry(s[0], 24, 16);
  if (g.type === "capsule") return new THREE.CapsuleGeometry(s[0], 2 * s[1], 8, 16);
  if (g.type === "cylinder") return new THREE.CylinderGeometry(s[0], s[0], 2 * s[1], 24);
  if (g.type === "box") return new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]);
  if (g.type === "ellipsoid") return new THREE.SphereGeometry(1, 24, 16).scale(s[0], s[1], s[2]);
  return null;
}

function label(text, color) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(32, 32, 28, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "600 34px system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 34);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  sprite.scale.set(0.035, 0.035, 1);
  sprite.position.set(0, 0, 0.06);
  sprite.renderOrder = 10;
  return sprite;
}
