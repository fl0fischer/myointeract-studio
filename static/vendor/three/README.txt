three.js r186 (0.186.1, MIT, see LICENSE): build/three.module.min.js, build/three.core.min.js (as three.core.js,
the name the module build imports) and examples/jsm addons OrbitControls, TransformControls, GLTFExporter.
The addons import "../three.module.min.js" instead of the bare "three", so no import map is needed
(hosts such as claude.ai artifacts may not honour one). Vendored so Studio works offline and on hosted copies.
