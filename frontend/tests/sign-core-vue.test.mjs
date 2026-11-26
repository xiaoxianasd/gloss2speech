import test from "node:test";
import assert from "node:assert/strict";

import {
  D_POINTS,
  DTWMatcher,
  FEAT_DIM,
  FeatureExtractor,
  HAND_POINTS,
  HAND_SIZE,
  MotionVAD,
  Normalizer,
  PALM_INDEX,
  packHandLandmarks,
  resample,
} from "../src/utils/signCore.js";

function makeHand(originX = 0.5, originY = 0.5, scale = 0.12, fingerCurl = 0) {
  const pts = [];
  for (let i = 0; i < HAND_SIZE; i += 1) {
    const angle = (i / HAND_SIZE) * Math.PI + fingerCurl * 0.4;
    const radius = i === 0 ? 0 : i === PALM_INDEX ? scale : scale * (0.5 + (i % 5) * 0.15);
    pts.push({
      x: originX + Math.sin(angle) * radius,
      y: originY - Math.cos(angle) * radius,
      z: 0,
    });
  }
  return pts;
}

function makeWaveSequence(length, { xStart = 0.35, xEnd = 0.65, yBase = 0.5, curl = 0, singleRight = true } = {}) {
  const seq = [];
  for (let i = 0; i < length; i += 1) {
    const t = length > 1 ? i / (length - 1) : 0;
    const x = xStart + (xEnd - xStart) * t;
    const y = yBase + Math.sin(t * Math.PI * 2) * 0.08;
    const hand = makeHand(x, y, 0.12, curl + t * 0.8);
    if (singleRight) {
      seq.push(packHandLandmarks([hand], [[{ categoryName: "Right" }]]));
    } else {
      const left = makeHand(0.3, 0.55, 0.1, curl);
      seq.push(packHandLandmarks([left, hand], [[{ categoryName: "Left" }], [{ categoryName: "Right" }]]));
    }
  }
  return seq;
}

test("packHandLandmarks places Left at 0..20 and Right at 21..41", () => {
  const rightOnly = makeHand(0.7, 0.4, 0.1);
  const packed = packHandLandmarks([rightOnly], [[{ categoryName: "Right" }]]);
  assert.equal(packed.length, HAND_POINTS * 3);
  assert.equal(packed[0], 0);
  assert.equal(packed[1], 0);
  const rightWristIdx = HAND_SIZE * 3;
  assert.ok(Math.abs(packed[rightWristIdx] - rightOnly[0].x) < 1e-6);
  assert.ok(Math.abs(packed[rightWristIdx + 1] - rightOnly[0].y) < 1e-6);
});

test("Normalizer handles zero, dual, and translation-invariant single hands", () => {
  const zeroOut = Normalizer.points(new Float32Array(HAND_POINTS * 3));
  assert.equal(zeroOut.length, D_POINTS);
  assert.ok(zeroOut.every((v) => v === 0));

  const handA = makeHand(0.25, 0.35, 0.1, 0.2);
  const handShifted = handA.map((p) => ({ x: p.x + 0.42, y: p.y + 0.28, z: 0 }));

  const packedA = packHandLandmarks([handA], ["Right"]);
  const packedShifted = packHandLandmarks([handShifted], ["Right"]);

  const normA = Normalizer.points(packedA);
  const normShifted = Normalizer.points(packedShifted);

  let maxDiff = 0;
  for (let i = 0; i < D_POINTS; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(normA[i] - normShifted[i]));
  }
  assert.ok(maxDiff < 1e-5, `Single-hand normalization should be translation-invariant, got diff=${maxDiff}`);

  const left = makeHand(0.3, 0.5, 0.1);
  const right = makeHand(0.7, 0.5, 0.1);
  const dualNorm = Normalizer.points(packHandLandmarks([left, right], ["Left", "Right"]));
  // Dual-hand wrist midpoint should be around origin -> wrists symmetric at (-0.5, 0) and (+0.5, 0)
  assert.ok(Math.abs(dualNorm[0] + 0.5) < 1e-4);
  assert.ok(Math.abs(dualNorm[HAND_SIZE * 2] - 0.5) < 1e-4);
});

test("FeatureExtractor outputs 336-D vectors with temporal delta", () => {
  const ext = new FeatureExtractor();
  const f1 = ext.step(packHandLandmarks([makeHand(0.4, 0.5, 0.1, 0)], ["Right"]));
  assert.equal(f1.length, FEAT_DIM);
  for (let i = FEAT_DIM / 2; i < FEAT_DIM; i += 1) {
    assert.equal(f1[i], 0);
  }
  const f2 = ext.step(packHandLandmarks([makeHand(0.5, 0.45, 0.1, 1.0)], ["Right"]));
  const deltaEnergy = f2.slice(FEAT_DIM / 2).reduce((acc, v) => acc + Math.abs(v), 0);
  assert.ok(deltaEnergy > 0.1);
});

test("resample interpolates sequence length cleanly", () => {
  const src = [Float32Array.from([0, 10]), Float32Array.from([10, 20])];
  const out = resample(src, 5);
  assert.equal(out.length, 5);
  assert.equal(out[2][0], 5);
  assert.equal(out[2][1], 15);
});

test("MotionVAD detects motion segment and ignores stationary entry", () => {
  const vad = new MotionVAD({
    tStart: 0.012,
    tStop: 0.006,
    minHotFrames: 2,
    cooldownFrames: 3,
    minSegmentFrames: 4,
  });

  // Static hand appearing in frame should stay idle
  for (let i = 0; i < 6; i += 1) {
    const res = vad.step(packHandLandmarks([makeHand(0.5, 0.5, 0.1)], ["Right"]), { hasHands: true });
    assert.equal(res.state, "IDLE");
  }

  // Active movement triggers SIGNING -> end when settled
  let started = false;
  let endedSegment = null;
  for (let i = 0; i < 12; i += 1) {
    const x = 0.25 + i * 0.04;
    const res = vad.step(packHandLandmarks([makeHand(x, 0.5, 0.1, i * 0.2)], ["Right"]), { hasHands: true });
    if (res.event === "start") started = true;
  }
  assert.equal(started, true);

  for (let i = 0; i < 6; i += 1) {
    const res = vad.step(packHandLandmarks([makeHand(0.7, 0.5, 0.1, 2.2)], ["Right"]), { hasHands: true });
    if (res.event === "end") endedSegment = res.frames;
  }
  assert.ok(Array.isArray(endedSegment) && endedSegment.length >= 4);
});

test("DTWMatcher matches warped sequence, isolates scenes, and roundtrips JSON", () => {
  const matcher = new DTWMatcher({ minConfidence: 0.55 });
  const helloTpl = makeWaveSequence(20, { xStart: 0.3, xEnd: 0.7, yBase: 0.4, curl: 0 });
  const painTpl = makeWaveSequence(20, { xStart: 0.5, xEnd: 0.5, yBase: 0.6, curl: 2.5, singleRight: false });

  matcher.addTemplate({ sceneId: "hospital", label: "你好", seq: helloTpl });
  matcher.addTemplate({ sceneId: "hospital", label: "头疼", seq: painTpl });
  matcher.addTemplate({ sceneId: "bank", label: "取钱", seq: helloTpl });

  assert.equal(matcher.size("hospital"), 2);
  assert.equal(matcher.size("bank"), 1);

  // Query speed-warped (12 frames instead of 20) & slightly offset
  const queryHello = makeWaveSequence(12, { xStart: 0.35, xEnd: 0.75, yBase: 0.42, curl: 0.05 });
  const resHosp = matcher.match(queryHello, { sceneId: "hospital" });
  assert.equal(resHosp.matched, true);
  assert.equal(resHosp.label, "你好");
  assert.ok(resHosp.confidence >= 0.55);

  const resBank = matcher.match(queryHello, { sceneId: "bank" });
  assert.equal(resBank.label, "取钱");

  // Delete label and verify summary
  assert.equal(matcher.deleteLabel("你好", "hospital"), 1);
  assert.deepEqual(matcher.summary("hospital"), [{ label: "头疼", count: 1 }]);

  // Export & import JSON roundtrip
  const exported = matcher.exportTemplates("hospital");
  const jsonCopy = JSON.parse(JSON.stringify(exported));
  const matcher2 = new DTWMatcher({ minConfidence: 0.55 });
  const imported = matcher2.importTemplates(jsonCopy, { replace: true });
  assert.equal(imported, 1);
  const resCopy = matcher2.match(painTpl, { sceneId: "hospital" });
  assert.equal(resCopy.matched, true);
  assert.equal(resCopy.label, "头疼");
});
