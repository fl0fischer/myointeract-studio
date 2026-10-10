// Import a Figma frame in the page itself (Figma's REST API allows browser calls): the frame's
// interactive elements and a PNG of it. Mirrors studio/figma.py; the token goes only to api.figma.com.

const FIGMA_API = "https://api.figma.com/v1";
export const MAX_ELEMENTS = 15;  // Studio's target limit
const INTERACTIVE = /button|btn|key|icon|link|tab|toggle|check|switch|slider|input|field|menu|item/i;
const LEAF_TYPES = new Set(["INSTANCE", "COMPONENT"]);

// File key and node id ("12:34") of a Figma frame link.
export function parseFigmaUrl(url) {
  const match = /figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/.exec(url);
  if (!match) throw new Error("This is not a link to a Figma file.");
  let node = "";
  try { node = new URL(url).searchParams.get("node-id") || ""; } catch (e) {}
  if (!node) throw new Error('The link has no frame: in Figma, select the frame and use "Copy link to selection".');
  return [match[1], node.replace(/-/g, ":")];
}

// Frame size and its interactive elements, in pixels relative to the frame's top-left corner.
// Elements are component instances and nodes named like controls; a picked element's children are
// not searched. Without any, the frame's direct children are used.
export function frameElements(node, limit = MAX_ELEMENTS) {
  const box = node.absoluteBoundingBox;
  const rel = (n) => { const b = n.absoluteBoundingBox; return { name: n.name || "", x: b.x - box.x, y: b.y - box.y, w: b.width, h: b.height }; };
  const usable = (n) => { const b = n.absoluteBoundingBox; return n.visible !== false && !!b && b.width > 0 && b.height > 0; };
  let picked = [];
  const walk = (n) => {
    for (const child of n.children || []) {
      if (!usable(child)) continue;
      if (LEAF_TYPES.has(child.type) || INTERACTIVE.test(child.name || "")) picked.push(rel(child));
      else walk(child);
    }
  };
  walk(node);
  if (!picked.length) picked = (node.children || []).filter(usable).map(rel);
  picked = picked.map((e, i) => [e, i]).sort(([a, i], [b, j]) => Math.round(a.y) - Math.round(b.y) || a.x - b.x || i - j).map(([e]) => e);
  return { name: node.name || "frame", width: box.width, height: box.height, elements: picked.slice(0, limit), more: Math.max(0, picked.length - limit) };
}

async function get(url, token) {
  let r;
  try { r = await fetch(url, token ? { headers: { "X-Figma-Token": token } } : {}); }
  catch (e) { throw new Error("Figma is not reachable from this page."); }
  if (r.status === 401 || r.status === 403) throw new Error("Figma refused the token: create a personal access token with file read access.");
  if (r.status === 404) throw new Error("Figma does not know this file or frame (or the token cannot see it).");
  if (!r.ok) throw new Error(`Figma answered HTTP ${r.status}.`);
  return r;
}

// Frame, elements and a PNG (data URL) of the frame a Figma link points to.
export async function fetchFrame(url, token) {
  const [key, nodeId] = parseFigmaUrl(url), ids = encodeURIComponent(nodeId);
  const nodes = await (await get(`${FIGMA_API}/files/${key}/nodes?ids=${ids}`, token)).json();
  const entry = (nodes.nodes || {})[nodeId];
  if (!entry || !entry.document) throw new Error("Figma does not know this frame.");
  const frame = frameElements(entry.document);
  const images = await (await get(`${FIGMA_API}/images/${key}?ids=${ids}&format=png&scale=1`, token)).json();
  const imageUrl = (images.images || {})[nodeId];
  if (!imageUrl) throw new Error("Figma could not render this frame as an image.");
  let blob;
  try { blob = await (await fetch(imageUrl)).blob(); }
  catch (e) { throw new Error("The frame's image could not be downloaded in the page."); }
  frame.image = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The frame's image could not be read."));
    reader.readAsDataURL(blob);
  });
  return frame;
}
