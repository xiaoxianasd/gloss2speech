/**
 * ES Module Web Worker for SignBridge edge DTW inference & template management.
 * Offloads MotionVAD segmentation, 336-D feature extraction, Sakoe-Chiba DTW,
 * and IndexedDB persistence off the UI main thread.
 */

import {
  DTWMatcher,
  MotionVAD,
  defaultConfig,
  packHandLandmarks,
} from "./signCore.js";

const DB_NAME = "signbridge_v2";
const DB_VERSION = 1;
const STORE_NAME = "templates";

let dbInstance = null;
let currentSceneId = "hospital";
let cfg = defaultConfig();
const vad = new MotionVAD(cfg);
const matcher = new DTWMatcher(cfg);
let recording = null;
let wasSigning = false;

function openDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
          store.createIndex("by_scene", "sceneId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbLoadAll(db) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

function serializeEntry(entry) {
  return {
    key: entry.key,
    sceneId: entry.sceneId,
    label: entry.label,
    speaker: entry.speaker,
    createdAt: entry.createdAt,
    seq: entry.seq.map((row) => Array.from(row)),
  };
}

function idbPutEntries(db, entries) {
  if (!db || !entries || entries.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const entry of entries) {
        store.put(serializeEntry(entry));
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function idbDeleteKeys(db, keys) {
  if (!db || !keys || keys.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const k of keys) {
        store.delete(k);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function initWorker() {
  dbInstance = await openDatabase();
  const rows = await idbLoadAll(dbInstance);
  if (rows.length > 0) {
    matcher.importTemplates(rows, { replace: true });
  }
  emitTemplatesSummary();
}

const readyPromise = initWorker();

function emitTemplatesSummary() {
  self.postMessage({
    type: "templates_updated",
    sceneId: currentSceneId,
    totalCount: matcher.size(currentSceneId),
    allCount: matcher.size(),
    summary: matcher.summary(currentSceneId),
  });
}

async function saveTemplateSequence({ sceneId, label, speaker, frames }) {
  const entry = matcher.addTemplate({
    sceneId,
    label,
    speaker,
    seq: frames,
  });
  if (!entry) return null;
  await idbPutEntries(dbInstance, [entry]);
  return entry;
}

async function deleteByPredicate(predicate) {
  const keysToDelete = [];
  for (const [key, item] of matcher.templates.entries()) {
    if (predicate(item)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    matcher.templates.delete(key);
  }
  await idbDeleteKeys(dbInstance, keysToDelete);
  return keysToDelete.length;
}

async function handleFrame(msg) {
  let frameData = msg.packed;
  if (!frameData && Array.isArray(msg.landmarks)) {
    frameData = packHandLandmarks(msg.landmarks, msg.handednesses || []);
  }
  if (!frameData) {
    frameData = new Float32Array(42 * 3);
  }

  const hasHands = Boolean(msg.hasHands);
  if (recording && hasHands) {
    recording.capturedFrames.push(Float32Array.from(frameData));
    if (recording.capturedFrames.length > cfg.maxSegmentFrames) {
      recording.capturedFrames.shift();
    }
  }

  const res = vad.step(frameData, { hasHands, ts: msg.ts });

  if (res.event === "start") {
    wasSigning = true;
    self.postMessage({
      type: "vad_state",
      state: "SIGNING",
      event: "start",
      energy: res.energy,
    });
    return;
  }

  if (res.event === "signing" || res.event === "hold") {
    if (
      !recording &&
      res.frames.length >= 6 &&
      res.frames.length % 6 === 0 &&
      matcher.size(currentSceneId) > 0
    ) {
      const preview = matcher.match(res.frames, {
        sceneId: currentSceneId,
        threshold: cfg.previewConfidence,
      });
      if (preview.matched) {
        self.postMessage({
          type: "provisional",
          sceneId: currentSceneId,
          label: preview.label,
          confidence: preview.confidence,
          elapsedMs: preview.elapsedMs,
          framesCount: res.frames.length,
        });
      }
    }
    return;
  }

  if (res.event === "end") {
    wasSigning = false;
    self.postMessage({
      type: "vad_state",
      state: "IDLE",
      event: "end",
      energy: res.energy,
    });

    if (recording) {
      const rec = recording;
      recording = null;
      const entry = await saveTemplateSequence({
        sceneId: rec.sceneId,
        label: rec.label,
        speaker: rec.speaker,
        frames: res.frames,
      });
      emitTemplatesSummary();
      self.postMessage({
        type: "recorded",
        sceneId: rec.sceneId,
        label: rec.label,
        framesCount: res.frames.length,
        ok: Boolean(entry),
        totalCount: matcher.size(rec.sceneId),
        summary: matcher.summary(rec.sceneId),
      });
      return;
    }

    const match = matcher.match(res.frames, {
      sceneId: currentSceneId,
      threshold: cfg.minConfidence,
    });
    self.postMessage({
      type: "segment_end",
      sceneId: currentSceneId,
      framesCount: res.frames.length,
      ts: msg.ts || Date.now(),
      ...match,
    });
    return;
  }

  if (res.event === "cancel") {
    wasSigning = false;
    self.postMessage({
      type: "vad_state",
      state: "IDLE",
      event: "cancel",
      energy: res.energy,
    });
    return;
  }

  if (wasSigning && res.state === "IDLE") {
    wasSigning = false;
    self.postMessage({
      type: "vad_state",
      state: "IDLE",
      event: "idle",
      energy: res.energy,
    });
  }
}

self.onmessage = async (event) => {
  await readyPromise;
  const msg = event.data || {};
  const { type, requestId } = msg;

  try {
    switch (type) {
      case "init":
      case "set_scene": {
        currentSceneId = msg.sceneId || "hospital";
        vad.reset();
        wasSigning = false;
        recording = null;
        emitTemplatesSummary();
        self.postMessage({
          type: "scene_ready",
          requestId,
          sceneId: currentSceneId,
          totalCount: matcher.size(currentSceneId),
          summary: matcher.summary(currentSceneId),
        });
        break;
      }

      case "config": {
        cfg = defaultConfig({ ...cfg, ...(msg.config || {}) });
        vad.configure(cfg);
        matcher.configure(cfg);
        self.postMessage({ type: "config_updated", requestId, config: cfg });
        break;
      }

      case "reset_vad": {
        vad.reset();
        wasSigning = false;
        self.postMessage({ type: "vad_state", requestId, state: "IDLE", event: "reset", energy: 0 });
        break;
      }

      case "frame": {
        await handleFrame(msg);
        break;
      }

      case "match_segment": {
        const scene = msg.sceneId || currentSceneId;
        const frames = Array.isArray(msg.frames) ? msg.frames : [];
        const match = matcher.match(frames, {
          sceneId: scene,
          threshold: msg.threshold ?? cfg.minConfidence,
        });
        self.postMessage({
          type: "segment_result",
          requestId,
          sceneId: scene,
          framesCount: frames.length,
          ...match,
        });
        break;
      }

      case "record_start": {
        const label = String(msg.label || "").trim();
        if (!label) {
          self.postMessage({ type: "record_failed", requestId, reason: "empty_label" });
          break;
        }
        const scene = msg.sceneId || currentSceneId;
        recording = {
          label,
          speaker: msg.speaker || "user",
          sceneId: scene,
          startedAt: Date.now(),
          capturedFrames: [],
        };
        vad.reset();
        wasSigning = false;
        self.postMessage({
          type: "recording_started",
          requestId,
          label,
          sceneId: scene,
        });
        break;
      }

      case "record_cancel": {
        recording = null;
        vad.reset();
        wasSigning = false;
        self.postMessage({ type: "recording_cancelled", requestId });
        break;
      }

      case "record_force_end": {
        if (!recording) {
          self.postMessage({ type: "recording_cancelled", requestId });
          break;
        }
        const rec = recording;
        recording = null;
        wasSigning = false;
        const vadFrames = vad.state === "SIGNING" ? vad.forceEnd() : [];
        vad.reset();
        const frames =
          Array.isArray(msg.frames) && msg.frames.length >= 2
            ? msg.frames
            : vadFrames.length >= 2
              ? vadFrames
              : rec.capturedFrames;

        if (!frames || frames.length < 2) {
          self.postMessage({
            type: "record_failed",
            requestId,
            reason: "too_short",
            label: rec.label,
          });
          break;
        }

        const entry = await saveTemplateSequence({
          sceneId: rec.sceneId,
          label: rec.label,
          speaker: rec.speaker,
          frames,
        });
        emitTemplatesSummary();
        self.postMessage({
          type: "recorded",
          requestId,
          sceneId: rec.sceneId,
          label: rec.label,
          framesCount: frames.length,
          ok: Boolean(entry),
          totalCount: matcher.size(rec.sceneId),
          summary: matcher.summary(rec.sceneId),
        });
        break;
      }

      case "delete_label": {
        const scene = msg.sceneId ?? currentSceneId;
        const label = String(msg.label || "").trim();
        const removed = await deleteByPredicate(
          (item) => item.label === label && (scene === null || item.sceneId === scene),
        );
        emitTemplatesSummary();
        self.postMessage({ type: "label_deleted", requestId, label, sceneId: scene, removed });
        break;
      }

      case "clear_scene_templates": {
        const scene = msg.sceneId ?? currentSceneId;
        const removed = await deleteByPredicate((item) => scene === null || item.sceneId === scene);
        emitTemplatesSummary();
        self.postMessage({ type: "scene_cleared", requestId, sceneId: scene, removed });
        break;
      }

      case "export_templates": {
        const scene = msg.sceneId === undefined ? currentSceneId : msg.sceneId;
        self.postMessage({
          type: "exported_templates",
          requestId,
          sceneId: scene,
          items: matcher.exportTemplates(scene),
        });
        break;
      }

      case "import_templates": {
        const scene = msg.sceneId || currentSceneId;
        const replace = Boolean(msg.replace);
        if (replace) {
          await deleteByPredicate((item) => item.sceneId === scene);
        }
        const rawItems = Array.isArray(msg.items) ? msg.items : [];
        const beforeKeys = new Set(matcher.templates.keys());
        const count = matcher.importTemplates(rawItems, {
          replace: false,
          defaultSceneId: scene,
        });
        const addedEntries = [];
        for (const [k, v] of matcher.templates.entries()) {
          if (!beforeKeys.has(k)) {
            addedEntries.push(v);
          }
        }
        await idbPutEntries(dbInstance, addedEntries);
        emitTemplatesSummary();
        self.postMessage({
          type: "imported_templates",
          requestId,
          sceneId: scene,
          count,
        });
        break;
      }

      default:
        break;
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      requestId,
      message: err && err.message ? err.message : String(err),
    });
  }
};
