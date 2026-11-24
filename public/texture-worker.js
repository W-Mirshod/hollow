/* The Hollow: paints procedural surfaces on another CPU core (started by prepaint.js). visuals.js runs here without a
 * DOM, so surface() returns its maps as raw RGBA pixels, which are handed back without copying. */
'use strict';
self.window = self;
importScripts('visuals.js' + self.location.search);

self.onmessage = ({ data }) => {
  const visuals = self.HollowVisuals;
  visuals.configure({ quality: data.quality });
  const kinds = visuals.surfacePlan(data.quality, data.workers, data.order)[data.index] || [];
  self.postMessage({ kinds });
  for (const kind of kinds) {
    try {
      const painted = visuals.surface(kind), transfer = [];
      for (const value of Object.values(painted)) {
        if (value && value.data && !transfer.includes(value.data.buffer)) transfer.push(value.data.buffer);
      }
      self.postMessage({ kind, painted }, transfer);
    } catch (error) {
      self.postMessage({ kind, error: String(error && error.message || error) });
    }
  }
  self.postMessage({ done: true });
};
