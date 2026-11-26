/**
 * Pure-JS client-side sign language DTW engine & landmark feature pipeline.
 * Zero DOM/browser APIs so it can run identically in Web Workers and Node tests.
 */

export const HAND_SIZE = 21;
export const HAND_POINTS = HAND_SIZE * 2; // 42 (0..20 Left, 21..41 Right)
export const PALM_INDEX = 9; // Middle finger MCP
export const D_POINTS = HAND_POINTS * 2; // 84 (2D x,y)
export const D_EMBED = D_POINTS * 2; // 168 (global normalized + local palm-relative)
export const FEAT_DIM = D_EMBED * 2; // 336 (static embed + temporal delta)

const EPS = 1e-4;

export function defaultConfig(overrides = {}) {
  return {
    emaAlpha: 0.4,
    tStart: 0.012,
    tStop: 0.006,
    minHotFrames: 2,
    cooldownFrames: 5,
    preRollFrames: 4,
    minSegmentFrames: 4,
    maxSegmentFrames: 60,
    matchLength: 24,
    coarseK: 8,
    sakoeBand: 0.3,
    confidenceScale: 0.55,
    minConfidence: 0.55,
    previewConfidence: 0.3,
    ...overrides,
  };
}

function readLabelName(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry.toLowerCase();
  if (Array.isArray(entry) && entry.length > 0) return readLabelName(entry[0]);
  return String(entry.categoryName || entry.displayName || entry.label || "").toLowerCase();
}

/**
 * Pack MediaPipe HandLandmarker results into a fixed 42x3 Float32Array:
 * slots 0..20 = Left hand, slots 21..41 = Right hand.
 */
export function packHandLandmarks(landmarks = [], handednesses = []) {
  const out = new Float32Array(HAND_POINTS * 3);
  if (!Array.isArray(landmarks) || landmarks.length === 0) {
    return out;
  }

  let leftUsed = false;
  let rightUsed = false;
  const fallbackQueue = [];

  for (let i = 0; i < landmarks.length; i += 1) {
    const hand = landmarks[i];
    if (!Array.isArray(hand) || hand.length === 0) continue;
    const side = readLabelName(handednesses[i]);
    if (side.includes("left") && !leftUsed) {
      copyHand(hand, out, 0);
      leftUsed = true;
    } else if (side.includes("right") && !rightUsed) {
      copyHand(hand, out, HAND_SIZE);
      rightUsed = true;
    } else {
      fallbackQueue.push(hand);
    }
  }

  for (const hand of fallbackQueue) {
    if (!leftUsed) {
      copyHand(hand, out, 0);
      leftUsed = true;
    } else if (!rightUsed) {
      copyHand(hand, out, HAND_SIZE);
      rightUsed = true;
    }
  }

  return out;
}

function copyHand(src, dst, dstPointOffset) {
  const count = Math.min(src.length, HAND_SIZE);
  for (let j = 0; j < count; j += 1) {
    const pt = src[j];
    const base = (dstPointOffset + j) * 3;
    dst[base] = pt && Number.isFinite(pt.x) ? pt.x : 0;
    dst[base + 1] = pt && Number.isFinite(pt.y) ? pt.y : 0;
    dst[base + 2] = pt && Number.isFinite(pt.z) ? pt.z : 0;
  }
}

/**
 * Convert packed (42x3 = 126), flat 2D (84), or point objects into Float32Array(84).
 */
export function toPoints2D(hand) {
  if (!hand) return new Float32Array(D_POINTS);
  if (hand.length === D_POINTS) {
    return hand instanceof Float32Array ? new Float32Array(hand) : Float32Array.from(hand);
  }
  const out = new Float32Array(D_POINTS);
  if (hand.length === HAND_POINTS * 3) {
    for (let i = 0; i < HAND_POINTS; i += 1) {
      out[i * 2] = hand[i * 3];
      out[i * 2 + 1] = hand[i * 3 + 1];
    }
    return out;
  }
  if (Array.isArray(hand)) {
    const count = Math.min(hand.length, HAND_POINTS);
    for (let i = 0; i < count; i += 1) {
      const pt = hand[i];
      if (pt && typeof pt === "object") {
        out[i * 2] = Number.isFinite(pt.x) ? pt.x : 0;
        out[i * 2 + 1] = Number.isFinite(pt.y) ? pt.y : 0;
      }
    }
  }
  return out;
}

export function hasValidHand(pts2d, handSlot) {
  const start = handSlot === 0 ? 0 : HAND_SIZE * 2;
  const end = start + HAND_SIZE * 2;
  for (let i = start; i < end; i += 2) {
    if (Math.abs(pts2d[i]) > 1e-6 || Math.abs(pts2d[i + 1]) > 1e-6) {
      return true;
    }
  }
  return false;
}

function handSpan(pts2d, base) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = 0; j < HAND_SIZE; j += 1) {
    const x = pts2d[base + j * 2];
    const y = pts2d[base + j * 2 + 1];
    if (Math.abs(x) <= 1e-6 && Math.abs(y) <= 1e-6) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.hypot(maxX - minX, maxY - minY);
}

function palmLength(pts2d, base) {
  const wx = pts2d[base];
  const wy = pts2d[base + 1];
  const px = pts2d[base + PALM_INDEX * 2];
  const py = pts2d[base + PALM_INDEX * 2 + 1];
  const len = Math.hypot(px - wx, py - wy);
  return len > 1e-5 ? len : handSpan(pts2d, base) * 0.5;
}

function extractPoseAnchor(pose) {
  if (!pose) return null;
  if (Array.isArray(pose) && pose.length > 12 && typeof pose[11] === "object") {
    const ls = pose[11];
    const rs = pose[12];
    if (ls && rs) {
      const dist = Math.hypot(rs.x - ls.x, rs.y - ls.y);
      if (dist > EPS) {
        return { cx: (ls.x + rs.x) * 0.5, cy: (ls.y + rs.y) * 0.5, scale: dist };
      }
    }
  } else if (pose.length >= 26 && typeof pose[22] === "number") {
    const lx = pose[22];
    const ly = pose[23];
    const rx = pose[24];
    const ry = pose[25];
    const dist = Math.hypot(rx - lx, ry - ly);
    if (dist > EPS) {
      return { cx: (lx + rx) * 0.5, cy: (ly + ry) * 0.5, scale: dist };
    }
  }
  return null;
}

export class Normalizer {
  /**
   * Normalize 42 hand 2D coordinates into an anchor-invariant Float32Array(84).
   * Hierarchy:
   *  1) Pose shoulder midpoint & width (when pose is supplied)
   *  2) Both hands present -> wrist midpoint & wrist distance (palm fallback if wrists overlap)
   *  3) Single hand present -> active wrist origin & palmLen * 3 scale (prevents origin drift to 0,0)
   *  4) Neither hand present -> zeroed Float32Array(84)
   */
  static points(hand, pose = null) {
    const pts = toPoints2D(hand);
    const hasLeft = hasValidHand(pts, 0);
    const hasRight = hasValidHand(pts, 1);

    if (!hasLeft && !hasRight) {
      return new Float32Array(D_POINTS);
    }

    let cx = 0;
    let cy = 0;
    let scale = 1;

    const poseAnchor = extractPoseAnchor(pose);
    if (poseAnchor) {
      cx = poseAnchor.cx;
      cy = poseAnchor.cy;
      scale = poseAnchor.scale;
    } else if (hasLeft && hasRight) {
      const lx = pts[0];
      const ly = pts[1];
      const rx = pts[HAND_SIZE * 2];
      const ry = pts[HAND_SIZE * 2 + 1];
      cx = (lx + rx) * 0.5;
      cy = (ly + ry) * 0.5;
      const wristDist = Math.hypot(rx - lx, ry - ly);
      const avgPalm = (palmLength(pts, 0) + palmLength(pts, HAND_SIZE * 2)) * 0.5;
      scale = wristDist > 1e-3 ? wristDist : Math.max(avgPalm * 3, EPS);
    } else {
      const base = hasLeft ? 0 : HAND_SIZE * 2;
      cx = pts[base];
      cy = pts[base + 1];
      const pLen = palmLength(pts, base);
      scale = Math.max(pLen * 3, EPS);
    }

    const inv = 1 / Math.max(scale, EPS);
    const out = new Float32Array(D_POINTS);
    if (hasLeft) {
      for (let j = 0; j < HAND_SIZE; j += 1) {
        const idx = j * 2;
        out[idx] = (pts[idx] - cx) * inv;
        out[idx + 1] = (pts[idx + 1] - cy) * inv;
      }
    }
    if (hasRight) {
      const base = HAND_SIZE * 2;
      for (let j = 0; j < HAND_SIZE; j += 1) {
        const idx = base + j * 2;
        out[idx] = (pts[idx] - cx) * inv;
        out[idx + 1] = (pts[idx + 1] - cy) * inv;
      }
    }
    return out;
  }
}

export class FeatureExtractor {
  constructor() {
    this.prevEmbed = null;
  }

  reset() {
    this.prevEmbed = null;
  }

  embed(normPts) {
    const out = new Float32Array(D_EMBED);
    out.set(normPts, 0);

    // Local palm-centered coordinates highlight finger articulation
    const leftActive = hasValidHand(normPts, 0);
    if (leftActive) {
      const px = normPts[PALM_INDEX * 2];
      const py = normPts[PALM_INDEX * 2 + 1];
      for (let j = 0; j < HAND_SIZE; j += 1) {
        out[D_POINTS + j * 2] = normPts[j * 2] - px;
        out[D_POINTS + j * 2 + 1] = normPts[j * 2 + 1] - py;
      }
    }

    const rightActive = hasValidHand(normPts, 1);
    if (rightActive) {
      const base = HAND_SIZE * 2;
      const px = normPts[base + PALM_INDEX * 2];
      const py = normPts[base + PALM_INDEX * 2 + 1];
      for (let j = 0; j < HAND_SIZE; j += 1) {
        const idx = base + j * 2;
        out[D_POINTS + idx] = normPts[idx] - px;
        out[D_POINTS + idx + 1] = normPts[idx + 1] - py;
      }
    }

    return out;
  }

  step(hand, pose = null) {
    const normPts = Normalizer.points(hand, pose);
    const cur = this.embed(normPts);
    const feat = new Float32Array(FEAT_DIM);
    feat.set(cur, 0);
    if (this.prevEmbed) {
      for (let i = 0; i < D_EMBED; i += 1) {
        feat[D_EMBED + i] = cur[i] - this.prevEmbed[i];
      }
    }
    this.prevEmbed = cur;
    return feat;
  }

  static extractSequence(frames, poses = null) {
    const ext = new FeatureExtractor();
    return frames.map((frame, idx) => ext.step(frame, poses ? poses[idx] : null));
  }
}

export function resample(seq, targetLen) {
  if (!Array.isArray(seq) || seq.length === 0 || targetLen <= 0) {
    return [];
  }
  const n = seq.length;
  const dim = seq[0].length;
  if (n === 1) {
    return Array.from({ length: targetLen }, () => Float32Array.from(seq[0]));
  }
  if (n === targetLen) {
    return seq.map((f) => Float32Array.from(f));
  }

  const out = new Array(targetLen);
  const scale = (n - 1) / (targetLen - 1);
  for (let i = 0; i < targetLen; i += 1) {
    const pos = i * scale;
    const lo = Math.floor(pos);
    const hi = Math.min(n - 1, lo + 1);
    const frac = pos - lo;
    const a = seq[lo];
    const b = seq[hi];
    const row = new Float32Array(dim);
    for (let d = 0; d < dim; d += 1) {
      row[d] = a[d] + (b[d] - a[d]) * frac;
    }
    out[i] = row;
  }
  return out;
}

/**
 * Screen-space landmark motion VAD with EMA smoothing & hysteresis.
 * Tracks per-hand presence so hand entry/exit never triggers fake 0<->0.5 jumps.
 */
export class MotionVAD {
  constructor(config = {}) {
    this.cfg = defaultConfig(config);
    this.reset();
  }

  configure(config = {}) {
    this.cfg = defaultConfig({ ...this.cfg, ...config });
  }

  reset() {
    this.state = "IDLE";
    this.ema = 0;
    this.hotCount = 0;
    this.coolCount = 0;
    this.preRoll = [];
    this.segment = [];
    this._prevPts = null;
    this._prevLeft = false;
    this._prevRight = false;
  }

  _computeEnergy(pts2d) {
    const hasLeft = hasValidHand(pts2d, 0);
    const hasRight = hasValidHand(pts2d, 1);

    let sum = 0;
    let count = 0;
    if (this._prevPts) {
      if (hasLeft && this._prevLeft) {
        for (let j = 0; j < HAND_SIZE; j += 1) {
          const idx = j * 2;
          sum += Math.hypot(pts2d[idx] - this._prevPts[idx], pts2d[idx + 1] - this._prevPts[idx + 1]);
          count += 1;
        }
      }
      if (hasRight && this._prevRight) {
        const base = HAND_SIZE * 2;
        for (let j = 0; j < HAND_SIZE; j += 1) {
          const idx = base + j * 2;
          sum += Math.hypot(pts2d[idx] - this._prevPts[idx], pts2d[idx + 1] - this._prevPts[idx + 1]);
          count += 1;
        }
      }
    }

    this._prevPts = pts2d;
    this._prevLeft = hasLeft;
    this._prevRight = hasRight;

    return {
      hasHands: hasLeft || hasRight,
      rawEnergy: count > 0 ? sum / count : 0,
    };
  }

  step(frame, meta = {}) {
    const pts2d = toPoints2D(frame);
    const { hasHands: ptsHaveHands, rawEnergy } = this._computeEnergy(pts2d);
    const hasHands = meta.hasHands === undefined ? ptsHaveHands : Boolean(meta.hasHands && ptsHaveHands);

    if (!hasHands) {
      this.ema *= 0.5;
      this.hotCount = 0;
      if (this.state === "SIGNING") {
        this.coolCount += 1;
        if (this.coolCount >= this.cfg.cooldownFrames) {
          const finished = this.segment.slice();
          this.state = "IDLE";
          this.coolCount = 0;
          this.segment = [];
          this.preRoll = [];
          if (finished.length >= this.cfg.minSegmentFrames) {
            return { event: "end", energy: this.ema, state: this.state, frames: finished };
          }
          return { event: "cancel", energy: this.ema, state: this.state, frames: [] };
        }
        return { event: "hold", energy: this.ema, state: this.state, frames: this.segment };
      }
      this.preRoll = [];
      return { event: "idle", energy: this.ema, state: this.state, frames: [] };
    }

    const a = this.cfg.emaAlpha;
    this.ema = this.ema === 0 ? rawEnergy : a * rawEnergy + (1 - a) * this.ema;

    const frameCopy = frame instanceof Float32Array ? Float32Array.from(frame) : pts2d;

    if (this.state === "IDLE") {
      this.preRoll.push(frameCopy);
      if (this.preRoll.length > this.cfg.preRollFrames) {
        this.preRoll.shift();
      }
      if (this.ema >= this.cfg.tStart) {
        this.hotCount += 1;
        if (this.hotCount >= this.cfg.minHotFrames) {
          this.state = "SIGNING";
          this.hotCount = 0;
          this.coolCount = 0;
          this.segment = this.preRoll.slice();
          this.preRoll = [];
          return { event: "start", energy: this.ema, state: this.state, frames: this.segment };
        }
      } else {
        this.hotCount = 0;
      }
      return { event: "idle", energy: this.ema, state: this.state, frames: [] };
    }

    // SIGNING
    this.segment.push(frameCopy);
    if (this.segment.length >= this.cfg.maxSegmentFrames) {
      const finished = this.segment.slice();
      this.state = "IDLE";
      this.coolCount = 0;
      this.segment = [];
      return { event: "end", energy: this.ema, state: this.state, frames: finished };
    }

    if (this.ema <= this.cfg.tStop) {
      this.coolCount += 1;
      if (this.coolCount >= this.cfg.cooldownFrames) {
        const finished = this.segment.slice(0, Math.max(1, this.segment.length - this.cfg.cooldownFrames + 1));
        this.state = "IDLE";
        this.coolCount = 0;
        this.segment = [];
        if (finished.length >= this.cfg.minSegmentFrames) {
          return { event: "end", energy: this.ema, state: this.state, frames: finished };
        }
        return { event: "cancel", energy: this.ema, state: this.state, frames: [] };
      }
    } else {
      this.coolCount = 0;
    }

    return { event: "signing", energy: this.ema, state: this.state, frames: this.segment };
  }

  forceEnd() {
    if (this.state !== "SIGNING") {
      this.reset();
      return [];
    }
    const finished = this.segment.slice();
    this.reset();
    return finished.length >= this.cfg.minSegmentFrames ? finished : [];
  }
}

function frameRmsDistance(a, b) {
  let sum = 0;
  const dim = a.length;
  for (let d = 0; d < dim; d += 1) {
    const diff = a[d] - b[d];
    sum += diff * diff;
  }
  return Math.sqrt(sum / dim);
}

function coarseDistance(seqA, seqB) {
  const n = Math.min(seqA.length, seqB.length);
  if (n === 0) return Infinity;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    total += frameRmsDistance(seqA[i], seqB[i]);
  }
  return total / n;
}

/**
 * Symmetric Sakoe-Chiba constrained DTW distance normalized by (n + m).
 */
export function dtwDistance(seqA, seqB, bandRatio = 0.3) {
  const n = seqA.length;
  const m = seqB.length;
  if (n === 0 || m === 0) return Infinity;

  const band = Math.max(1, Math.round(Math.max(n, m) * bandRatio));
  let prev = new Float64Array(m + 1);
  let curr = new Float64Array(m + 1);
  prev.fill(Infinity);
  prev[0] = 0;

  for (let i = 1; i <= n; i += 1) {
    curr.fill(Infinity);
    const jCenter = Math.round((i * m) / n);
    const jStart = Math.max(1, jCenter - band);
    const jEnd = Math.min(m, jCenter + band);
    const aFrame = seqA[i - 1];

    for (let j = jStart; j <= jEnd; j += 1) {
      const step = frameRmsDistance(aFrame, seqB[j - 1]);
      const diag = prev[j - 1] + 2 * step;
      const up = prev[j] + step;
      const left = curr[j - 1] + step;
      curr[j] = Math.min(diag, up, left);
    }

    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[m] / (n + m);
}

export class DTWMatcher {
  constructor(config = {}) {
    this.cfg = defaultConfig(config);
    this.templates = new Map();
  }

  configure(config = {}) {
    this.cfg = defaultConfig({ ...this.cfg, ...config });
  }

  _normalizeSeq(seq) {
    if (!Array.isArray(seq) || seq.length === 0) return [];
    const first = seq[0];
    const isFeatures = first && first.length === FEAT_DIM;
    const features = isFeatures
      ? seq.map((f) => (f instanceof Float32Array ? f : Float32Array.from(f)))
      : FeatureExtractor.extractSequence(seq);
    return resample(features, this.cfg.matchLength);
  }

  addTemplate({ key, sceneId = "hospital", label, speaker = "default", seq, createdAt = Date.now() }) {
    if (!label || !Array.isArray(seq) || seq.length === 0) {
      return null;
    }
    const normSeq = this._normalizeSeq(seq);
    if (normSeq.length === 0) return null;
    const coarse = resample(normSeq, this.cfg.coarseK);
    const entryKey = key || `${sceneId}::${label}::${createdAt}::${Math.random().toString(36).slice(2, 7)}`;
    const entry = {
      key: entryKey,
      sceneId,
      label: String(label).trim(),
      speaker: speaker || "default",
      seq: normSeq,
      coarse,
      createdAt,
    };
    this.templates.set(entryKey, entry);
    return entry;
  }

  deleteLabel(label, sceneId = null) {
    const target = String(label || "").trim();
    let removed = 0;
    for (const [key, item] of this.templates.entries()) {
      if (item.label === target && (sceneId === null || item.sceneId === sceneId)) {
        this.templates.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(sceneId = null) {
    if (sceneId === null) {
      const count = this.templates.size;
      this.templates.clear();
      return count;
    }
    let removed = 0;
    for (const [key, item] of this.templates.entries()) {
      if (item.sceneId === sceneId) {
        this.templates.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size(sceneId = null) {
    if (sceneId === null) return this.templates.size;
    let count = 0;
    for (const item of this.templates.values()) {
      if (item.sceneId === sceneId) count += 1;
    }
    return count;
  }

  summary(sceneId = null) {
    const counts = new Map();
    for (const item of this.templates.values()) {
      if (sceneId !== null && item.sceneId !== sceneId) continue;
      counts.set(item.label, (counts.get(item.label) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
  }

  exportTemplates(sceneId = null) {
    const out = [];
    for (const item of this.templates.values()) {
      if (sceneId !== null && item.sceneId !== sceneId) continue;
      out.push({
        key: item.key,
        sceneId: item.sceneId,
        label: item.label,
        speaker: item.speaker,
        createdAt: item.createdAt,
        seq: item.seq.map((row) => Array.from(row, (v) => Number(v.toFixed(5)))),
      });
    }
    return out;
  }

  importTemplates(items, { replace = false, defaultSceneId = "hospital", sceneId = null } = {}) {
    if (!Array.isArray(items)) return 0;
    if (replace) {
      this.clear(sceneId);
    }
    let imported = 0;
    for (const raw of items) {
      if (!raw || !raw.label || !Array.isArray(raw.seq) || raw.seq.length === 0) continue;
      const entry = this.addTemplate({
        key: raw.key,
        sceneId: raw.sceneId || defaultSceneId,
        label: raw.label,
        speaker: raw.speaker || "imported",
        seq: raw.seq,
        createdAt: raw.createdAt || Date.now(),
      });
      if (entry) imported += 1;
    }
    return imported;
  }

  match(seq, { sceneId = null, topK = 3, threshold = this.cfg.minConfidence } = {}) {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const candidates = [];
    for (const item of this.templates.values()) {
      if (sceneId === null || item.sceneId === sceneId) {
        candidates.push(item);
      }
    }

    if (candidates.length === 0 || !Array.isArray(seq) || seq.length === 0) {
      return {
        matched: false,
        reason: candidates.length === 0 ? "no_templates" : "empty_sequence",
        label: "",
        speaker: "",
        confidence: 0,
        distance: Infinity,
        candidates: [],
        elapsedMs: 0,
      };
    }

    const queryNorm = this._normalizeSeq(seq);
    const queryCoarse = resample(queryNorm, this.cfg.coarseK);

    let pool = candidates;
    if (candidates.length > 10) {
      const scoredCoarse = candidates.map((tpl) => ({
        tpl,
        cDist: coarseDistance(queryCoarse, tpl.coarse),
      }));
      scoredCoarse.sort((a, b) => a.cDist - b.cDist);
      const keep = Math.max(6, Math.ceil(candidates.length * 0.4));
      pool = scoredCoarse.slice(0, keep).map((x) => x.tpl);
    }

    const byLabel = new Map();
    for (const tpl of pool) {
      const dist = dtwDistance(queryNorm, tpl.seq, this.cfg.sakoeBand);
      const prev = byLabel.get(tpl.label);
      if (!prev || dist < prev.distance) {
        byLabel.set(tpl.label, {
          label: tpl.label,
          speaker: tpl.speaker,
          distance: dist,
          confidence: Math.exp(-dist / Math.max(this.cfg.confidenceScale, EPS)),
        });
      }
    }

    const ranked = Array.from(byLabel.values()).sort((a, b) => a.distance - b.distance);
    const best = ranked[0];
    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();

    return {
      matched: Boolean(best && best.confidence >= threshold),
      reason: best ? (best.confidence >= threshold ? "matched" : "low_confidence") : "no_match",
      label: best ? best.label : "",
      speaker: best ? best.speaker : "",
      confidence: best ? best.confidence : 0,
      distance: best ? best.distance : Infinity,
      candidates: ranked.slice(0, topK),
      elapsedMs: Number((t1 - t0).toFixed(2)),
    };
  }
}
