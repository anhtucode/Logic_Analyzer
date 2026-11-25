"use strict";
// Only derived statistics run here. USB parsing, raw history and sample indexes
// remain owned by the main thread. Reuse exactly the same measurement algorithm.
importScripts("analysis.js?v=2.0-workbench");
self.onmessage = ({data}) => {
  try {
    const measurements = Array.from({length:8},(_,ch)=>LA.measure(data.samples,data.rate,ch,data.from,data.to));
    self.postMessage({id:data.id,measurements});
  } catch(error) { self.postMessage({id:data.id,error:error.message}); }
};
