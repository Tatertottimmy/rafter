// engine-worker.js — runs buildGrid and the face mesher off the page's main thread, so big
// builds never freeze the UI. Takes {seq, design}; answers {seq, xyz, pal, palette, min, max,
// meshes} (see encodeGrid and meshGrid), or {seq, error}.
import { buildGrid, encodeGrid } from './engine.js';
import { meshGrid } from './mesher.js';

self.onmessage = (e) => {
  const { seq, design } = e.data;
  try {
    const grid = buildGrid(design);
    const enc = encodeGrid(grid);
    const meshes = meshGrid(grid);
    const transfer = [enc.xyz.buffer, enc.pal.buffer];
    for (const m of meshes) {
      for (const part of [m.faces, m.caps]) transfer.push(part.pos.buffer, part.nor.buffer, part.uv.buffer, part.index.buffer);
      transfer.push(m.ys.buffer, m.start.buffer, m.capStart.buffer);
    }
    self.postMessage({ seq, ...enc, meshes }, transfer);
  } catch (err) {
    self.postMessage({ seq, error: String((err && err.message) || err) });
  }
};
