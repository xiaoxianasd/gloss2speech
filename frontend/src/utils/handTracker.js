/**
 * 浏览器端离线 MediaPipe HandLandmarker 封装：
 *   - 从本地 /vendor 加载，不依赖外部 CDN
 *   - 优先 GPU delegate，失败自动回退 CPU，再失败进入 fallback 模式不阻塞主链路
 */
import { computeHandBox } from "./roi";
import { packHandLandmarks } from "./signCore";

const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const EMPTY_RESULT = Object.freeze({
  hasHands: false,
  landmarks: [],
  handednesses: [],
  handBox: null,
  packed: null,
  updated: false,
});

export class HandTracker {
  constructor(options = {}) {
    this.status = "idle";
    this.delegate = "";
    this.error = "";
    this.lastResult = { ...EMPTY_RESULT };
    this._hands = null;
    this._initPromise = null;
    this._lastVideoTime = -1;
    this._lastTs = 0;
    this._minIntervalMs = Number.isFinite(options.minIntervalMs) ? options.minIntervalMs : 66;
    this._lastDetectAt = 0;
  }

  setMinInterval(ms) {
    if (Number.isFinite(ms) && ms >= 0) {
      this._minIntervalMs = ms;
    }
  }

  async init() {
    if (this.status === "ready") return true;
    if (this._initPromise) return this._initPromise;

    this.status = "loading";
    this._initPromise = this._loadModel();
    return this._initPromise;
  }

  async _loadModel() {
    try {
      const bundleUrl = new URL("/vendor/vision_bundle.js", window.location.origin).href;
      const { FilesetResolver, HandLandmarker } = await import(/* @vite-ignore */ bundleUrl);
      const vision = await FilesetResolver.forVisionTasks("/vendor/wasm");

      for (const delegate of ["GPU", "CPU"]) {
        try {
          this._hands = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: "/vendor/hand_landmarker.task",
              delegate,
            },
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.45,
            minHandPresenceConfidence: 0.45,
            minTrackingConfidence: 0.45,
          });
          this.status = "ready";
          this.delegate = delegate;
          this.error = "";
          return true;
        } catch (err) {
          this.error = err && err.message ? err.message : String(err);
        }
      }
    } catch (err) {
      this.error = err && err.message ? err.message : String(err);
    }

    this.status = "fallback";
    this._hands = null;
    return false;
  }

  detect(video, now) {
    if (this.status !== "ready" || !this._hands || !video || video.readyState < 2 || !video.videoWidth) {
      return { ...this.lastResult, updated: false };
    }
    if (video.currentTime === this._lastVideoTime) {
      return { ...this.lastResult, updated: false };
    }
    if (this._minIntervalMs > 0 && now - this._lastDetectAt < this._minIntervalMs) {
      return { ...this.lastResult, updated: false };
    }
    this._lastVideoTime = video.currentTime;
    this._lastDetectAt = now;

    const ts = Math.max(Math.floor(now), this._lastTs + 1);
    this._lastTs = ts;

    try {
      const res = this._hands.detectForVideo(video, ts);
      const landmarks = (res && res.landmarks) || [];
      const handednesses = (res && (res.handedness || res.handednesses)) || [];
      const handBox = computeHandBox(landmarks);
      const hasHands = landmarks.length > 0;
      const packed = hasHands ? packHandLandmarks(landmarks, handednesses) : null;
      this.lastResult = {
        hasHands,
        landmarks,
        handednesses,
        handBox,
        packed,
        updated: true,
      };
    } catch (err) {
      this.lastResult = { ...EMPTY_RESULT, updated: true };
    }
    return this.lastResult;
  }

  drawOverlay(canvas, video, landmarks, roiRect) {
    if (!canvas) return;
    const width = (video && video.videoWidth) || canvas.clientWidth || 1280;
    const height = (video && video.videoHeight) || canvas.clientHeight || 720;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);

    if (roiRect && roiRect.w > 0 && roiRect.h > 0) {
      ctx.save();
      ctx.strokeStyle = "rgba(56, 232, 208, 0.85)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(
        roiRect.x * width,
        roiRect.y * height,
        roiRect.w * width,
        roiRect.h * height,
      );
      ctx.restore();
    }

    if (!Array.isArray(landmarks) || landmarks.length === 0) return;

    ctx.lineWidth = 2;
    landmarks.forEach((hand, idx) => {
      const color = idx === 0 ? "#38e8d0" : "#ff7ac6";
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      for (const [a, b] of HAND_EDGES) {
        const pa = hand[a];
        const pb = hand[b];
        if (!pa || !pb) continue;
        ctx.beginPath();
        ctx.moveTo(pa.x * width, pa.y * height);
        ctx.lineTo(pb.x * width, pb.y * height);
        ctx.stroke();
      }
      for (const pt of hand) {
        ctx.beginPath();
        ctx.arc(pt.x * width, pt.y * height, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  close() {
    if (this._hands && typeof this._hands.close === "function") {
      try {
        this._hands.close();
      } catch (err) {
        /* ignore */
      }
    }
    this._hands = null;
    this.status = "idle";
    this.delegate = "";
    this._initPromise = null;
    this.lastResult = { ...EMPTY_RESULT };
    this._lastDetectAt = 0;
  }
}
