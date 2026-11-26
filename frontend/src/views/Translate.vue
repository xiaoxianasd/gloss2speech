<template>
  <div class="translate" :class="{ 'big-mode': bigSubtitle }">
    <div class="left-col">
      <section class="stage">
        <video ref="videoRef" class="video" autoplay playsinline muted></video>
        <canvas ref="overlayRef" class="overlay"></canvas>
        <div class="stage-empty" v-if="!cameraOn">点击「开启摄像头」开始</div>
        <div class="hud">
          <div>FPS <b>{{ fps }}</b></div>
          <div>动作 <b :class="'state-' + detectorState">{{ stateText }}</b></div>
          <div>diff <b>{{ diff }}</b></div>
          <div>手部 <b>{{ handStatusText }}</b></div>
          <div>ROI <b>{{ roiModeText }}</b></div>
        </div>
      </section>

      <el-card shadow="never" class="card history-card">
        <template #header>
          <div class="card-header-row">
            <span class="card-title">对话记录（{{ history.length }}）</span>
            <div class="row" v-if="history.length">
              <el-button size="small" text type="primary" @click="exportHistory">导出记录</el-button>
              <el-button size="small" text @click="clearHistory">清空记录</el-button>
            </div>
          </div>
        </template>
        <div v-if="!history.length" class="empty">暂无对话记录，打手语或点击反向沟通开始交流。</div>
        <div v-else class="history-list">
          <div v-for="(item, idx) in history" :key="idx" :class="['history-item', 'role-' + item.role]">
            <div class="history-meta">
              <span class="history-role">{{ item.role === 'other' ? '对方（语音）' : '我（手语）' }}</span>
              <span class="history-time">{{ item.time }}</span>
              <el-tag v-if="item.emergency" type="danger" size="small" effect="dark">紧急求助</el-tag>
              <el-tag v-if="item.guardTriggered" type="warning" size="small">护栏已介入</el-tag>
              <el-tag v-if="item.needConfirm && !item.emergency" type="info" size="small">待确认</el-tag>
            </div>
            <div class="history-body">
              <span class="history-text">{{ item.text }}</span>
              <el-button size="small" text type="primary" @click="speak(item.text)">朗读</el-button>
            </div>
            <div v-if="item.words && item.words.length" class="history-words">
              手语词：{{ item.words.join(' · ') }}
            </div>
          </div>
        </div>
      </el-card>
    </div>

    <aside class="panel">
      <el-card shadow="never" class="card">
        <div class="row">
          <el-select v-model="sceneId" size="small" style="width: 126px" @change="onSceneChange">
            <el-option v-for="scene in scenes" :key="scene.id" :label="scene.name" :value="scene.id" />
          </el-select>
          <el-button size="small" type="primary" @click="toggleCamera">{{ cameraOn ? '关闭摄像头' : '开启摄像头' }}</el-button>
          <el-switch v-model="autoMode" active-text="自动检测" @change="onModeChange" />
          <el-switch v-model="roiEnabled" active-text="ROI裁切" @change="onRoiChange" />
          <el-button size="small" type="danger" @click="triggerEmergency">紧急求助</el-button>
        </div>
        <div class="row thresholds">
          <span class="label">引擎</span>
          <el-radio-group v-model="engineMode" size="small">
            <el-radio-button value="hybrid">端云协同</el-radio-button>
            <el-radio-button value="cloud">云端视觉</el-radio-button>
            <el-radio-button value="dtw">端侧极速</el-radio-button>
          </el-radio-group>
          <el-button size="small" plain @click="openTemplateDialog">端侧模板 ({{ templateCount }})</el-button>
        </div>
        <div class="row thresholds" v-if="autoMode">
          <span class="label">T_start</span>
          <el-slider v-model="tStart" :min="2" :max="40" size="small" style="flex: 1" @change="applyThresholds" />
          <span class="value">{{ tStart }}</span>
        </div>
        <div class="row thresholds" v-if="autoMode">
          <span class="label">T_stop</span>
          <el-slider v-model="tStop" :min="1" :max="30" size="small" style="flex: 1" @change="applyThresholds" />
          <span class="value">{{ tStop }}</span>
        </div>
        <div class="row" v-if="!autoMode" style="margin-top: 8px">
          <el-button size="small" :type="manualRecording ? 'danger' : 'success'" @click="toggleManualRecord">
            {{ manualRecording ? '结束录制（空格）' : '开始录制（空格）' }}
          </el-button>
          <span class="hint">手动模式：录 2 秒左右的动作</span>
        </div>
      </el-card>

      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header-row">
            <span class="card-title">手语词序列</span>
            <div class="row">
              <el-button v-if="lastGridUrl" size="small" text @click="showGridPreview = !showGridPreview">
                {{ showGridPreview ? '收起拼图' : '查看最近拼图' }}
              </el-button>
              <el-button size="small" text @click="vocabOpen = !vocabOpen">
                {{ vocabOpen ? '收起词表' : '展开词表' }}
              </el-button>
            </div>
          </div>
        </template>
        <div class="words">
          <el-tag v-for="(word, index) in words" :key="index" closable size="large" @close="removeWord(index)">
            {{ word.text }}<span v-if="word.source" class="word-source"> · {{ word.source }}</span>
          </el-tag>
          <el-tag
            v-if="provisionalWord"
            type="info"
            effect="plain"
            size="large"
            class="provisional-tag"
          >
            {{ provisionalWord.label }} ({{ Math.round(provisionalWord.confidence * 100) }}% 预览)
          </el-tag>
          <span class="empty" v-if="!words.length && !provisionalWord">
            {{ engineMode === 'dtw' && templateCount === 0 ? '当前场景暂无端侧模板，请点击上方「端侧模板」录制或导入动作' : '等待识别或下方点选词表…' }}
          </span>
        </div>
        <div class="candidates" v-if="candidates.length">
          <span class="hint">置信度较低，请点选：</span>
          <el-button v-for="candidate in candidates" :key="candidate" size="small" @click="pickCandidate(candidate)">{{ candidate }}</el-button>
        </div>
        <div class="row" style="margin-top: 10px">
          <el-button size="small" type="primary" :disabled="!words.length || composing" @click="composeNow()">完成并造句</el-button>
          <el-button size="small" :disabled="!words.length" @click="clearWords">清空</el-button>
          <span class="hint" v-if="pendingRecognitions > 0">识别中（{{ pendingRecognitions }}）…</span>
          <span class="hint" v-if="pendingSentenceEnd">等待识别完成后自动造句…</span>
          <span class="hint" v-if="composing">流式造句中…</span>
        </div>

        <div class="grid-preview" v-if="showGridPreview && lastGridUrl">
          <div class="hint">最近上传 6 帧拼图（{{ lastRoiSource }}）：</div>
          <img :src="lastGridUrl" alt="6帧时序拼图" class="grid-img" />
        </div>

        <div class="vocab-box" v-if="vocabOpen && currentVocab.length">
          <div class="vocab-title">词表点选（兜底 · 悬停可看动作要领）</div>
          <div class="vocab-list">
            <el-button
              v-for="item in currentVocab"
              :key="item.word"
              size="small"
              class="vocab-btn"
              :title="item.desc"
              @click="addWord(item.word)"
            >
              {{ item.word }}
            </el-button>
          </div>
        </div>
      </el-card>

      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header-row">
            <span class="card-title">翻译结果</span>
            <el-switch v-model="bigSubtitle" active-text="大字模式" inline-prompt />
          </div>
        </template>
        <el-alert
          v-if="isEmergency"
          title="紧急求助旁路已触发：跳过大模型直接播报标准化求助语音"
          type="error"
          :closable="false"
          show-icon
          style="margin-bottom: 8px"
        />
        <el-alert
          v-if="guardTriggered"
          :title="'医疗/事实护栏已介入（' + guardReason + '），已回退安全表达'"
          type="warning"
          :closable="false"
          show-icon
          style="margin-bottom: 8px"
        />
        <div class="sentence">{{ sentence || '—' }}</div>
        <div class="confirm-row" v-if="needConfirm && !isEmergency">
          <el-tag type="warning" size="small">涉及医疗/高风险业务，请双方确认含义</el-tag>
        </div>
        <div class="alternative" v-if="alternative">
          备选：{{ alternative }}
          <el-button size="small" text type="primary" @click="useAlternative(alternative)">改用并播报</el-button>
        </div>
        <div class="row" style="margin-top: 10px">
          <el-button size="small" type="success" :disabled="!sentence" @click="speak(sentence)">播放语音</el-button>
          <span class="hint" v-if="speaking">正在播放…</span>
          <span class="hint" v-if="mockTip">{{ mockTip }}</span>
        </div>
      </el-card>

      <el-card shadow="never" class="card">
        <template #header><div class="card-title">反向沟通（健听人说话）</div></template>
        <div class="row">
          <el-button size="small" :type="recordingAudio ? 'danger' : 'primary'" @click="toggleAudioRecord">
            {{ recordingAudio ? '停止并识别' : '开始说话' }}
          </el-button>
          <span class="hint">按一次开始，再按一次结束</span>
        </div>
        <div class="other" v-if="otherText">对方说：{{ otherText }}</div>
        <div class="replies" v-if="replies.length">
          <el-button v-for="reply in replies" :key="reply" size="small" @click="sendQuickReply(reply)">{{ reply }}</el-button>
        </div>
      </el-card>
    </aside>

    <el-dialog v-model="templateDialogVisible" title="端侧手语模板管理（IndexedDB 本地存储）" width="540px" destroy-on-close>
      <div class="tpl-section">
        <div class="hint" style="margin-bottom: 10px">
          当前场景：<b>{{ sceneName }}</b>（已存 {{ templateCount }} 条模板）。每个常用词录制 1–3 次即可启用端侧极速匹配。
        </div>
        <el-alert
          v-if="!cameraOn || trackerStatus !== 'ready'"
          type="info"
          :closable="false"
          show-icon
          title="请先点击页面右上「开启摄像头」并等待手部追踪就绪后开始录制"
          style="margin-bottom: 12px"
        />
        <div class="row">
          <el-select
            v-model="recordLabel"
            filterable
            allow-create
            default-first-option
            placeholder="选择词表词或输入自定义词"
            size="small"
            style="width: 220px"
            :disabled="isRecordingTemplate"
          >
            <el-option v-for="item in currentVocab" :key="item.word" :label="item.word" :value="item.word" />
          </el-select>
          <el-button
            v-if="!isRecordingTemplate"
            type="primary"
            size="small"
            :disabled="!cameraOn || trackerStatus !== 'ready' || !recordLabel"
            @click="startTemplateRecord"
          >
            开始录制动作
          </el-button>
          <template v-else>
            <el-button type="success" size="small" @click="forceFinishTemplateRecord">结束并保存</el-button>
            <el-button size="small" @click="cancelTemplateRecord">取消</el-button>
          </template>
        </div>
        <div v-if="isRecordingTemplate" class="tpl-recording-tip">
          正在录制「<b>{{ recordLabel }}</b>」：请做出目标手势后停顿半秒自动保存，或手动点击「结束并保存」。
        </div>
      </div>

      <div class="tpl-list-box">
        <div class="vocab-title">本场景已录制词条（{{ templateSummary.length }} 类）</div>
        <div v-if="!templateSummary.length" class="empty">暂无端侧模板，可通过上方录制或下方导入 JSON 模板包。</div>
        <div v-else class="tpl-list">
          <div v-for="item in templateSummary" :key="item.label" class="tpl-item">
            <div class="row">
              <el-tag size="small">{{ item.label }}</el-tag>
              <span class="hint">{{ item.count }} 条模板</span>
            </div>
            <el-button size="small" text type="danger" @click="deleteTemplateLabel(item.label)">删除</el-button>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="tpl-footer">
          <div class="row">
            <el-button size="small" :disabled="!templateCount" @click="exportTemplatesToFile">导出 JSON</el-button>
            <el-button size="small" @click="triggerImportFile">导入 JSON</el-button>
            <el-button size="small" type="danger" plain :disabled="!templateCount" @click="clearSceneTemplates">清空本场景</el-button>
            <input ref="importInputRef" type="file" accept=".json" style="display: none" @change="onImportFileChange" />
          </div>
          <el-button size="small" type="primary" @click="templateDialogVisible = false">完成</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";
import { MotionDetector } from "../utils/motion";
import { captureFrame, composeGridWithMeta } from "../utils/grid";
import { HandTracker } from "../utils/handTracker";
import { computeSegmentRoi } from "../utils/roi";
import { AudioRecorder } from "../utils/recorder";

const props = defineProps({
  initialScenes: {
    type: Array,
    default: () => [],
  },
  scenesManaged: {
    type: Boolean,
    default: false,
  },
});

const videoRef = ref(null);
const overlayRef = ref(null);
const scenes = ref(Array.isArray(props.initialScenes) ? props.initialScenes : []);
const sceneId = ref("hospital");
const sceneName = ref("医院就诊");

const ENGINE_KEY = "signbridge.engine_mode.v1";
const savedEngine = (() => {
  try {
    const raw = localStorage.getItem(ENGINE_KEY);
    return raw === "cloud" || raw === "dtw" || raw === "hybrid" ? raw : "hybrid";
  } catch {
    return "hybrid";
  }
})();
const engineMode = ref(savedEngine);

const cameraOn = ref(false);
const autoMode = ref(true);
const roiEnabled = ref(true);
const detectorState = ref("IDLE");
const diff = ref("0.0");
const fps = ref("0");
const tStart = ref(6);
const tStop = ref(3);

const trackerStatus = ref("idle");
const handDetected = ref(false);
const liveRoi = ref(null);

const words = ref([]);
const provisionalWord = ref(null);
const candidates = ref([]);
const templateCount = ref(0);
const templateSummary = ref([]);
const templateDialogVisible = ref(false);
const recordLabel = ref("");
const isRecordingTemplate = ref(false);
const importInputRef = ref(null);
const vocabOpen = ref(true);
const showGridPreview = ref(false);
const lastGridUrl = ref("");
const lastRoiSource = ref("");

const sentence = ref("");
const alternative = ref("");
const composing = ref(false);
const speaking = ref(false);
const mockTip = ref("");
const isEmergency = ref(false);
const needConfirm = ref(false);
const guardTriggered = ref(false);
const guardReason = ref("");

const pendingRecognitions = ref(0);
const pendingSentenceEnd = ref(false);
const history = ref([]);

/* ---------------- 对话记录持久化（localStorage，刷新不丢） ---------------- */
const HISTORY_KEY = "signbridge.history.v1";
const HISTORY_LIMIT = 200;
let historySaveTimer = 0;

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return;
    const list = JSON.parse(raw);
    if (Array.isArray(list)) history.value = list.slice(-HISTORY_LIMIT);
  } catch (error) {
    /* 数据损坏时忽略，从空记录开始 */
  }
}

watch(
  history,
  function () {
    if (historySaveTimer) clearTimeout(historySaveTimer);
    historySaveTimer = window.setTimeout(function () {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value.slice(-HISTORY_LIMIT)));
      } catch (error) {
        /* 存储满（如长期未清理）时静默失败，不阻塞交互 */
      }
    }, 300);
  },
  { deep: true },
);

/* ---------------- 大字模式（面对面共看一台设备时用） ---------------- */
const BIG_KEY = "signbridge.big_subtitle";
const bigSubtitle = ref(false);
try {
  bigSubtitle.value = localStorage.getItem(BIG_KEY) === "1";
} catch (error) {
  /* ignore */
}
watch(bigSubtitle, function (value) {
  try {
    localStorage.setItem(BIG_KEY, value ? "1" : "0");
  } catch (error) {
    /* ignore */
  }
});

const manualRecording = ref(false);
const recordingAudio = ref(false);
const otherText = ref("");
const replies = ref([]);

let detector = null;
let tracker = null;
let signWorker = null;
let rafId = 0;
let stream = null;
let frameCount = 0;
let fpsAt = 0;
let manualTimer = 0;
let manualFrames = [];
let manualPackedFrames = [];
let hybridFrames = [];
let lastHybridFrameAt = 0;
let hybridSentenceTimer = 0;
let pendingManualMatches = new Map();
let pendingExportCallback = null;
let workerReqSeq = 0;
let wasOverlayDrawn = false;
let recorder = null;
let audioEl = null;
let speakSeq = 0;

const currentVocab = computed(function () {
  const found = scenes.value.find(function (item) {
    return item.id === sceneId.value;
  });
  return found && Array.isArray(found.vocab) ? found.vocab : [];
});

const stateText = computed(function () {
  const map = { IDLE: "空闲", SIGNING: "打手语中", COMMITTING: "等待句子结束" };
  return map[detectorState.value] || detectorState.value;
});

const handStatusText = computed(function () {
  if (!cameraOn.value) return "未启用";
  if (trackerStatus.value === "loading") return "加载中";
  if (trackerStatus.value === "fallback") return "降级帧差";
  if (trackerStatus.value !== "ready") return "未就绪";
  return handDetected.value ? "检测到" : "未检测到";
});

const roiModeText = computed(function () {
  if (!roiEnabled.value) return "全幅";
  return trackerStatus.value === "ready" ? "已裁切" : "居中4:3";
});

function formatDiff(value) {
  return (Math.round(value * 10) / 10).toFixed(1);
}

function formatNowTime() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(function (n) {
      return String(n).padStart(2, "0");
    })
    .join(":");
}

const canUseWorker = computed(function () {
  return trackerStatus.value === "ready" && Boolean(signWorker);
});

const effectiveAutoPipeline = computed(function () {
  if (isRecordingTemplate.value && canUseWorker.value) return "dtw_record";
  if (!autoMode.value) return "cloud";
  if (engineMode.value === "dtw") return "dtw";
  if (engineMode.value === "hybrid" && templateCount.value > 0 && canUseWorker.value) {
    return "hybrid";
  }
  return "cloud";
});

watch(engineMode, function (value) {
  try {
    localStorage.setItem(ENGINE_KEY, value);
  } catch (error) {
    /* ignore */
  }
  clearHybridSentenceTimer();
  provisionalWord.value = null;
  hybridFrames = [];
  if (detector) detector.reset();
  if (signWorker) signWorker.postMessage({ type: "reset_vad" });
  syncRequireHands();
});

watch(templateDialogVisible, function (open) {
  if (!open && isRecordingTemplate.value) {
    cancelTemplateRecord();
  }
});

watch(
  () => props.initialScenes,
  function (list) {
    if (Array.isArray(list) && list.length > 0) {
      applyScenesList(list);
    }
  },
);

function applyScenesList(list) {
  scenes.value = list;
  const found = list.find(function (item) {
    return item.id === sceneId.value;
  });
  if (!found && list[0]) {
    sceneId.value = list[0].id;
    sceneName.value = list[0].name;
  } else if (found) {
    sceneName.value = found.name;
  }
  if (signWorker) {
    signWorker.postMessage({ type: "set_scene", sceneId: sceneId.value });
  }
}

function syncRequireHands() {
  if (!detector) return;
  detector.setRequireHands(
    effectiveAutoPipeline.value === "cloud" && autoMode.value && roiEnabled.value && trackerStatus.value === "ready",
  );
}

function clearHybridSentenceTimer() {
  if (hybridSentenceTimer) {
    clearTimeout(hybridSentenceTimer);
    hybridSentenceTimer = 0;
  }
}

function scheduleHybridSentenceEnd() {
  clearHybridSentenceTimer();
  if (!autoMode.value || effectiveAutoPipeline.value === "cloud") return;
  if (words.value.length === 0 || pendingRecognitions.value > 0 || composing.value) return;
  hybridSentenceTimer = window.setTimeout(function () {
    hybridSentenceTimer = 0;
    if (
      autoMode.value &&
      effectiveAutoPipeline.value !== "cloud" &&
      detectorState.value === "IDLE" &&
      pendingRecognitions.value === 0 &&
      words.value.length > 0 &&
      !composing.value
    ) {
      composeNow();
    }
  }, 1800);
}

function syncWorkerThresholds() {
  if (!signWorker) return;
  signWorker.postMessage({
    type: "config",
    config: {
      tStart: Number((tStart.value * 0.002).toFixed(4)),
      tStop: Number((tStop.value * 0.002).toFixed(4)),
    },
  });
}

function initSignWorker() {
  if (typeof Worker === "undefined") return;
  try {
    signWorker = new Worker(new URL("../utils/signWorker.js", import.meta.url), { type: "module" });
    signWorker.onmessage = function (event) {
      handleWorkerMessage(event.data || {});
    };
    signWorker.onerror = function (err) {
      console.warn("signWorker error:", err);
    };
    signWorker.postMessage({ type: "set_scene", sceneId: sceneId.value });
    syncWorkerThresholds();
  } catch (err) {
    console.warn("signWorker init failed:", err);
    signWorker = null;
  }
}

function handleWorkerMessage(msg) {
  switch (msg.type) {
    case "templates_updated":
    case "scene_ready": {
      if (!msg.sceneId || msg.sceneId === sceneId.value) {
        templateCount.value = Number(msg.totalCount || 0);
        templateSummary.value = Array.isArray(msg.summary) ? msg.summary : [];
      }
      break;
    }
    case "vad_state": {
      if (effectiveAutoPipeline.value !== "cloud") {
        detectorState.value = msg.state || "IDLE";
        if (typeof msg.energy === "number") {
          diff.value = formatDiff(msg.energy * 100);
        }
        if (msg.state === "SIGNING") {
          clearHybridSentenceTimer();
          pendingSentenceEnd.value = false;
          hybridFrames = [];
          lastHybridFrameAt = 0;
        } else if (msg.event === "cancel") {
          provisionalWord.value = null;
          hybridFrames = [];
        }
      }
      break;
    }
    case "provisional": {
      if (!isRecordingTemplate.value && msg.label && effectiveAutoPipeline.value !== "cloud") {
        provisionalWord.value = {
          label: msg.label,
          confidence: Number(msg.confidence || 0),
        };
      }
      break;
    }
    case "segment_end": {
      provisionalWord.value = null;
      const fallbackFrames = hybridFrames.slice();
      hybridFrames = [];
      if (!autoMode.value || isRecordingTemplate.value) break;

      if (msg.matched && msg.label) {
        addWord(msg.label, { source: "端侧 " + (msg.elapsedMs ?? 0) + "ms" });
        scheduleHybridSentenceEnd();
      } else if (effectiveAutoPipeline.value === "hybrid") {
        const video = videoRef.value;
        if (fallbackFrames.length === 1 && video && video.readyState >= 2) {
          const handBox = tracker && tracker.lastResult ? tracker.lastResult.handBox : null;
          fallbackFrames.push(captureFrame(video, handBox));
        }
        if (fallbackFrames.length >= 2) {
          recognizeFrames(fallbackFrames);
        }
      } else if (effectiveAutoPipeline.value === "dtw") {
        const cands = Array.isArray(msg.candidates) ? msg.candidates.map((c) => c.label).filter(Boolean) : [];
        if (cands.length > 0) {
          candidates.value = cands;
          ElMessage.info("端侧未高置信命中，可点选候选词或补充录制模板");
        } else {
          ElMessage.info("端侧未匹配到已录制手语模板");
        }
      }
      break;
    }
    case "segment_result": {
      const pending = msg.requestId ? pendingManualMatches.get(msg.requestId) : null;
      if (msg.requestId) pendingManualMatches.delete(msg.requestId);
      if (msg.matched && msg.label) {
        addWord(msg.label, { source: "端侧 " + (msg.elapsedMs ?? 0) + "ms" });
      } else if (pending && pending.mode === "hybrid" && pending.frames && pending.frames.length >= 2) {
        recognizeFrames(pending.frames);
      } else {
        const cands = Array.isArray(msg.candidates) ? msg.candidates.map((c) => c.label).filter(Boolean) : [];
        if (cands.length > 0) {
          candidates.value = cands;
          ElMessage.info("端侧未高置信命中，可点选候选词");
        } else {
          ElMessage.warning("端侧未匹配到模板，请重打或录制该动作");
        }
      }
      break;
    }
    case "recorded": {
      isRecordingTemplate.value = false;
      detectorState.value = "IDLE";
      if (msg.ok) {
        ElMessage.success("已保存「" + msg.label + "」端侧模板（共 " + msg.totalCount + " 条）");
      } else {
        ElMessage.warning("录制失败，请重试");
      }
      break;
    }
    case "record_failed": {
      isRecordingTemplate.value = false;
      detectorState.value = "IDLE";
      ElMessage.warning(msg.reason === "too_short" ? "录制帧数过少，请完整做出动作后再结束" : "录制未能保存");
      break;
    }
    case "label_deleted": {
      if (msg.removed > 0) {
        ElMessage.success("已删除「" + msg.label + "」模板（" + msg.removed + " 条）");
      }
      break;
    }
    case "scene_cleared": {
      ElMessage.success("已清空本场景端侧模板");
      break;
    }
    case "exported_templates": {
      if (pendingExportCallback) {
        const cb = pendingExportCallback;
        pendingExportCallback = null;
        cb(msg.items || []);
      }
      break;
    }
    case "imported_templates": {
      ElMessage.success("成功导入 " + (msg.count || 0) + " 条端侧模板");
      break;
    }
    default:
      break;
  }
}

function openTemplateDialog() {
  if (!recordLabel.value && currentVocab.value.length > 0) {
    recordLabel.value = currentVocab.value[0].word;
  }
  templateDialogVisible.value = true;
}

function startTemplateRecord() {
  const label = String(recordLabel.value || "").trim();
  if (!label) {
    ElMessage.warning("请先选择或输入要录制的词");
    return;
  }
  if (!cameraOn.value || !canUseWorker.value) {
    ElMessage.warning("请先开启摄像头并等待手部追踪就绪");
    return;
  }
  isRecordingTemplate.value = true;
  provisionalWord.value = null;
  signWorker.postMessage({
    type: "record_start",
    label,
    sceneId: sceneId.value,
  });
}

function forceFinishTemplateRecord() {
  if (!signWorker || !isRecordingTemplate.value) return;
  signWorker.postMessage({ type: "record_force_end" });
}

function cancelTemplateRecord() {
  isRecordingTemplate.value = false;
  detectorState.value = "IDLE";
  if (signWorker) signWorker.postMessage({ type: "record_cancel" });
}

function deleteTemplateLabel(label) {
  if (!signWorker || !label) return;
  signWorker.postMessage({
    type: "delete_label",
    label,
    sceneId: sceneId.value,
  });
}

async function clearSceneTemplates() {
  if (!signWorker) return;
  try {
    await ElMessageBox.confirm("确定清空当前场景（「" + sceneName.value + "」）下的全部端侧模板吗？", "确认清空", {
      type: "warning",
      confirmButtonText: "清空",
      cancelButtonText: "取消",
    });
    signWorker.postMessage({ type: "clear_scene_templates", sceneId: sceneId.value });
  } catch {
    /* 取消 */
  }
}

function exportTemplatesToFile() {
  if (!signWorker) return;
  pendingExportCallback = function (items) {
    const payload = {
      version: 2,
      exportedAt: new Date().toISOString(),
      sceneId: sceneId.value,
      templates: items,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const now = new Date();
    link.href = url;
    link.download =
      "signbridge-templates-" +
      sceneId.value +
      "-" +
      now.getFullYear() +
      pad2(now.getMonth() + 1) +
      pad2(now.getDate()) +
      ".json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    ElMessage.success("已导出 " + items.length + " 条模板");
  };
  signWorker.postMessage({ type: "export_templates", sceneId: sceneId.value });
}

function triggerImportFile() {
  if (importInputRef.value) {
    importInputRef.value.value = "";
    importInputRef.value.click();
  }
}

function onImportFileChange(event) {
  const file = event && event.target && event.target.files && event.target.files[0];
  if (!file || !signWorker) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const parsed = JSON.parse(String(reader.result || "{}"));
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.templates) ? parsed.templates : [];
      if (!items.length) {
        ElMessage.warning("导入文件中未发现有效模板");
        return;
      }
      signWorker.postMessage({
        type: "import_templates",
        sceneId: sceneId.value,
        replace: false,
        items,
      });
    } catch {
      ElMessage.error("JSON 文件解析失败");
    }
  };
  reader.readAsText(file, "utf-8");
}

/* ---------------- 初始化 ---------------- */
onMounted(async function () {
  loadHistory();
  if (Array.isArray(props.initialScenes) && props.initialScenes.length > 0) {
    applyScenesList(props.initialScenes);
  } else if (!props.scenesManaged) {
    try {
      const loaded = await api.getScenes();
      if (Array.isArray(loaded) && loaded.length > 0) {
        applyScenesList(loaded);
      }
    } catch (error) {
      if (!error || error.status !== 401) {
        ElMessage.error("加载场景失败：" + error.message);
      }
    }
  }
  initSignWorker();
  tracker = new HandTracker({ minIntervalMs: 66 });
  detector = new MotionDetector({ tStart: tStart.value, tStop: tStop.value });
  detector.onStateChange = function (state) {
    if (effectiveAutoPipeline.value === "cloud") {
      detectorState.value = state;
    }
    if (state === "SIGNING") {
      pendingSentenceEnd.value = false;
    }
  };
  detector.onActionEnd = function (frames) {
    if (!autoMode.value || effectiveAutoPipeline.value !== "cloud") return;
    recognizeFrames(frames);
  };
  detector.onSentenceEnd = function () {
    if (!autoMode.value || effectiveAutoPipeline.value !== "cloud") return;
    if (pendingRecognitions.value > 0) {
      pendingSentenceEnd.value = true;
      return;
    }
    if (words.value.length > 0) composeNow();
  };
  rafId = requestAnimationFrame(loop);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(function () {
  cancelAnimationFrame(rafId);
  clearHybridSentenceTimer();
  window.removeEventListener("keydown", onKeydown);
  stopCamera();
  stopManualRecord();
  if (signWorker) {
    signWorker.terminate();
    signWorker = null;
  }
  if (tracker) tracker.close();
  if (recorder) recorder.close();
  if (audioEl) audioEl.pause();
});

/* ---------------- 主循环 ---------------- */
function loop(now) {
  rafId = requestAnimationFrame(loop);
  const video = videoRef.value;
  if (!cameraOn.value || !video || !detector) return;

  const handMeta = tracker && trackerStatus.value === "ready" ? tracker.detect(video, now) : null;
  if (handMeta && handMeta.updated) {
    handDetected.value = Boolean(handMeta.hasHands);

    if (roiEnabled.value && handMeta.handBox) {
      liveRoi.value = computeSegmentRoi(
        [{ handBox: handMeta.handBox }],
        video.videoWidth || 640,
        video.videoHeight || 480,
      );
    } else {
      liveRoi.value = null;
    }

    if (tracker && overlayRef.value) {
      tracker.drawOverlay(
        overlayRef.value,
        video,
        handMeta.landmarks || [],
        roiEnabled.value ? liveRoi.value : null,
      );
      wasOverlayDrawn = true;
    }
  } else if (!handMeta && wasOverlayDrawn && overlayRef.value) {
    const ctx = overlayRef.value.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, overlayRef.value.width, overlayRef.value.height);
    wasOverlayDrawn = false;
  }

  if (!autoMode.value && manualRecording.value && handMeta && handMeta.updated && handMeta.hasHands && handMeta.packed) {
    if (manualPackedFrames.length < 60) {
      manualPackedFrames.push(Float32Array.from(handMeta.packed));
    }
  }

  const pipeline = effectiveAutoPipeline.value;
  if (pipeline === "dtw_record" || pipeline === "dtw" || pipeline === "hybrid") {
    if (handMeta && handMeta.updated && signWorker) {
      signWorker.postMessage({
        type: "frame",
        packed: handMeta.packed ? Float32Array.from(handMeta.packed) : null,
        hasHands: Boolean(handMeta.hasHands),
        ts: now,
      });
    }
    if (pipeline === "hybrid" && detectorState.value === "SIGNING") {
      if (now - lastHybridFrameAt >= 200 && hybridFrames.length < 18 && video.readyState >= 2) {
        lastHybridFrameAt = now;
        hybridFrames.push(captureFrame(video, handMeta ? handMeta.handBox : null));
      }
    }
  } else {
    detector.push(video, now, handMeta);
    diff.value = formatDiff(detector.diff);
  }

  frameCount += 1;
  if (!fpsAt) fpsAt = now;
  if (now - fpsAt >= 500) {
    fps.value = String(Math.round((frameCount * 1000) / (now - fpsAt)));
    frameCount = 0;
    fpsAt = now;
  }
}

/* ---------------- 摄像头与手部追踪 ---------------- */
async function initHandTracker() {
  if (!tracker) return;
  if (tracker.status === "ready" || tracker.status === "fallback") {
    trackerStatus.value = tracker.status;
    syncRequireHands();
    return;
  }
  trackerStatus.value = "loading";
  await tracker.init();
  trackerStatus.value = tracker.status;
  syncRequireHands();
}

async function toggleCamera() {
  if (cameraOn.value) {
    stopCamera();
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 }, facingMode: "user" },
      audio: false,
    });
    const video = videoRef.value;
    video.srcObject = stream;
    await video.play();
    cameraOn.value = true;
    detector.reset();
    if (signWorker) signWorker.postMessage({ type: "reset_vad" });
    if (!fpsAt) fpsAt = performance.now();
    initHandTracker();
  } catch (error) {
    ElMessage.error("摄像头打开失败：" + (error.message || error) + "（需要 HTTPS 或 localhost）");
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(function (track) {
      track.stop();
    });
    stream = null;
  }
  if (videoRef.value) videoRef.value.srcObject = null;
  if (overlayRef.value) {
    const ctx = overlayRef.value.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, overlayRef.value.width, overlayRef.value.height);
  }
  wasOverlayDrawn = false;
  cameraOn.value = false;
  handDetected.value = false;
  liveRoi.value = null;
  provisionalWord.value = null;
  hybridFrames = [];
  clearHybridSentenceTimer();
  if (isRecordingTemplate.value) cancelTemplateRecord();
  if (detector) detector.reset();
  if (signWorker) signWorker.postMessage({ type: "reset_vad" });
}

/* ---------------- 识别 ---------------- */
async function recognizeFrames(frames) {
  if (!frames || frames.length < 2) return;
  const grid = composeGridWithMeta(frames, {
    frameWidth: 320,
    frameHeight: 240,
    useRoi: roiEnabled.value,
  });
  lastGridUrl.value = grid.dataUrl;
  lastRoiSource.value = grid.roi ? grid.roi.source : "";
  await recognizeImage(grid.dataUrl);
}

async function recognizeImage(image) {
  pendingRecognitions.value += 1;
  try {
    const result = await api.recognize(image, sceneId.value);
    mockTip.value = result.mock ? "当前为 Mock 识别（未配置 MaaS 密钥）" : "";
    const recognized = Array.isArray(result.words) ? result.words : [];
    const options = [];
    recognized.forEach(function (w) {
      if (w && options.indexOf(w) === -1) options.push(w);
    });
    const alternates = Array.isArray(result.alternatives) ? result.alternatives : [];
    alternates.forEach(function (group) {
      if (Array.isArray(group)) {
        group.forEach(function (word) {
          if (word && options.indexOf(word) === -1) options.push(word);
        });
      } else if (typeof group === "string" && group && options.indexOf(group) === -1) {
        options.push(group);
      }
    });

    if (!recognized.length) {
      if (options.length) {
        candidates.value = options;
        ElMessage.warning("未匹配词表，请点选候选词或下方词表");
      } else {
        ElMessage.warning("这个动作没有识别出词，请重打或从下方词表点选");
      }
      return;
    }

    const confidence = Number(result.confidence || 0);
    const sourceLabel = result.mock ? "Mock" : "云端";
    if (confidence >= 0.6) {
      recognized.forEach(function (word) {
        addWord(word, { source: sourceLabel });
      });
    } else {
      candidates.value = options;
      ElMessage.info("置信度较低（" + Math.round(confidence * 100) + "%），请点选候选词");
    }
  } catch (error) {
    if (!error || error.status !== 401) {
      ElMessage.error("识别失败：" + error.message);
    }
  } finally {
    pendingRecognitions.value = Math.max(0, pendingRecognitions.value - 1);
    if (pendingRecognitions.value === 0 && pendingSentenceEnd.value) {
      pendingSentenceEnd.value = false;
      if (words.value.length > 0 && !composing.value) {
        composeNow();
      }
    }
  }
}

function addWord(text, meta) {
  if (!text) return;
  words.value.push({
    text: text,
    source: meta && meta.source ? meta.source : "",
  });
  candidates.value = [];
}

function pickCandidate(text) {
  addWord(text);
}

function removeWord(index) {
  words.value.splice(index, 1);
}

function clearWords() {
  words.value = [];
  provisionalWord.value = null;
  candidates.value = [];
  sentence.value = "";
  alternative.value = "";
  isEmergency.value = false;
  needConfirm.value = false;
  guardTriggered.value = false;
  guardReason.value = "";
  clearHybridSentenceTimer();
}

function clearHistory() {
  history.value = [];
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch (error) {
    /* ignore */
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function exportHistory() {
  if (!history.value.length) return;
  const lines = history.value.map(function (item) {
    const role = item.role === "other" ? "对方（语音）" : "我（手语）";
    let line = "[" + (item.time || "--:--:--") + "] " + role + "：" + item.text;
    if (item.words && item.words.length) line += "（手语词：" + item.words.join(" · ") + "）";
    if (item.emergency) line += "【紧急求助】";
    return line;
  });
  const now = new Date();
  const header =
    "手语通 SignBridge 对话记录\n" +
    "导出时间：" + now.toLocaleString() + "\n" +
    "场景：" + sceneName.value + "\n" +
    "条数：" + lines.length + "\n\n";
  const blob = new Blob([header + lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download =
    "手语通对话记录-" +
    now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) +
    "-" + pad2(now.getHours()) + pad2(now.getMinutes()) + ".txt";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  ElMessage.success("已导出 " + lines.length + " 条对话记录");
}

function onSceneChange() {
  const scene = scenes.value.find(function (item) {
    return item.id === sceneId.value;
  });
  sceneName.value = scene ? scene.name : sceneId.value;
  clearWords();
  hybridFrames = [];
  if (signWorker) {
    signWorker.postMessage({ type: "set_scene", sceneId: sceneId.value });
  }
}

/* ---------------- 流式造句与紧急求助 ---------------- */
async function composeNow(overrideWords) {
  const isOverride = Array.isArray(overrideWords);
  const wordTexts = isOverride
    ? overrideWords.filter(Boolean)
    : words.value.map(function (item) {
        return item.text;
      });
  if (!wordTexts.length || composing.value) return;

  composing.value = true;
  pendingSentenceEnd.value = false;
  sentence.value = "";
  alternative.value = "";
  isEmergency.value = false;
  needConfirm.value = false;
  guardTriggered.value = false;
  guardReason.value = "";

  const recentHistory = history.value.slice(-5).map(function (turn) {
    return { role: turn.role, text: turn.text };
  });

  await api.composeStream(wordTexts, sceneId.value, recentHistory, {
    onDelta: function (text) {
      sentence.value += text;
    },
    onDone: function (fullSentence, alt, meta) {
      composing.value = false;
      if (fullSentence) sentence.value = fullSentence;
      alternative.value = alt || "";
      isEmergency.value = Boolean(meta && meta.emergency);
      needConfirm.value = Boolean(meta && meta.need_confirm);
      guardTriggered.value = Boolean(meta && meta.guard_triggered);
      guardReason.value = (meta && meta.guard_reason) || "";

      history.value.push({
        role: "me",
        text: sentence.value,
        words: wordTexts.slice(),
        time: formatNowTime(),
        emergency: isEmergency.value,
        needConfirm: needConfirm.value,
        guardTriggered: guardTriggered.value,
      });

      if (!isOverride) {
        words.value = [];
        candidates.value = [];
      }
      speak(sentence.value);
    },
    onError: function (error) {
      composing.value = false;
      if (!error || error.status !== 401) {
        ElMessage.error("造句失败：" + error.message);
      }
    },
  });
}

function triggerEmergency() {
  composeNow(["急救"]);
}

function useAlternative(altText) {
  if (!altText) return;
  sentence.value = altText;
  speak(altText);
}

/* ---------------- 语音播放 ---------------- */
async function speak(text) {
  if (!text) return;
  const seq = ++speakSeq;
  if (audioEl) {
    audioEl.pause();
    audioEl = null;
  }
  speaking.value = true;
  try {
    const result = await api.tts(text);
    if (seq !== speakSeq) return;
    audioEl = new Audio("data:audio/wav;base64," + result.audio);
    audioEl.onended = function () {
      if (seq === speakSeq) speaking.value = false;
    };
    audioEl.onerror = function () {
      if (seq === speakSeq) speaking.value = false;
    };
    await audioEl.play();
  } catch (error) {
    if (seq === speakSeq) {
      speaking.value = false;
      if (!error || error.status !== 401) {
        ElMessage.error("语音播放失败：" + error.message);
      }
    }
  }
}

/* ---------------- 手动录制与模式开关 ---------------- */
function toggleManualRecord() {
  if (manualRecording.value) {
    stopManualRecord();
    return;
  }
  if (!cameraOn.value) {
    ElMessage.warning("请先开启摄像头");
    return;
  }
  manualFrames = [];
  manualPackedFrames = [];
  manualRecording.value = true;
  manualTimer = window.setInterval(function () {
    const video = videoRef.value;
    if (video && video.readyState >= 2) {
      const handBox = trackerStatus.value === "ready" && tracker && tracker.lastResult
        ? tracker.lastResult.handBox
        : null;
      manualFrames.push(captureFrame(video, handBox));
    }
  }, 200);
}

function stopManualRecord() {
  if (!manualRecording.value) return;
  manualRecording.value = false;
  if (manualTimer) {
    clearInterval(manualTimer);
    manualTimer = 0;
  }
  const frames = manualFrames;
  const packed = manualPackedFrames;
  manualFrames = [];
  manualPackedFrames = [];

  if (engineMode.value === "dtw" && canUseWorker.value) {
    if (packed.length >= 4) {
      const requestId = "manual_" + ++workerReqSeq;
      pendingManualMatches.set(requestId, { mode: "dtw", frames });
      signWorker.postMessage({ type: "match_segment", requestId, frames: packed, sceneId: sceneId.value });
    } else {
      ElMessage.warning("未检测到足够手部关键点帧（至少需 4 帧），请确保手在画面中");
    }
    return;
  }

  if (engineMode.value === "hybrid" && templateCount.value > 0 && canUseWorker.value && packed.length >= 4) {
    const requestId = "manual_" + ++workerReqSeq;
    pendingManualMatches.set(requestId, { mode: "hybrid", frames });
    signWorker.postMessage({ type: "match_segment", requestId, frames: packed, sceneId: sceneId.value });
    return;
  }

  if (engineMode.value === "dtw") {
    ElMessage.warning("端侧极速模式需等待手部追踪就绪");
    return;
  }

  if (frames.length >= 2) recognizeFrames(frames);
}

function applyThresholds() {
  if (detector) detector.setThresholds(tStart.value, tStop.value);
  syncWorkerThresholds();
}

function onModeChange(value) {
  if (detector) detector.reset();
  if (signWorker) signWorker.postMessage({ type: "reset_vad" });
  clearHybridSentenceTimer();
  hybridFrames = [];
  provisionalWord.value = null;
  pendingSentenceEnd.value = false;
  syncRequireHands();
  if (value && manualRecording.value) stopManualRecord();
}

function onRoiChange() {
  syncRequireHands();
}

function onKeydown(event) {
  if (event.code !== "Space" || event.repeat) return;
  const tag = (event.target && event.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (autoMode.value) return;
  event.preventDefault();
  toggleManualRecord();
}

/* ---------------- 反向语音 ---------------- */
async function toggleAudioRecord() {
  if (!recordingAudio.value) {
    recorder = new AudioRecorder();
    try {
      await recorder.start();
      recordingAudio.value = true;
    } catch (error) {
      ElMessage.error("麦克风打开失败：" + (error.message || error));
    }
    return;
  }
  recordingAudio.value = false;
  try {
    const result = await recorder.stop();
    recorder.close();
    const asr = await api.asr(result.wavBase64);
    otherText.value = asr.text || "（没有听清）";
    history.value.push({
      role: "other",
      text: otherText.value,
      time: formatNowTime(),
    });
    const quick = await api.quickReply(otherText.value, sceneId.value);
    replies.value = quick.replies || [];
  } catch (error) {
    if (!error || error.status !== 401) {
      ElMessage.error("语音识别失败：" + error.message);
    }
  }
}

async function sendQuickReply(text) {
  sentence.value = text;
  history.value.push({
    role: "me",
    text: text,
    time: formatNowTime(),
  });
  await speak(text);
}
</script>

<style scoped>
.translate {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(380px, 1fr);
  gap: 16px;
  align-items: start;
}

.left-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.stage {
  position: relative;
  background: #000;
  border: 1px solid #26304b;
  border-radius: 14px;
  overflow: hidden;
  aspect-ratio: 16 / 9;
  min-height: 320px;
}

.video,
.overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
}

.overlay {
  pointer-events: none;
}

.stage-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8b96b3;
  font-size: 15px;
}

.hud {
  position: absolute;
  right: 10px;
  top: 10px;
  background: rgba(10, 16, 32, 0.82);
  border: 1px solid #26304b;
  border-radius: 10px;
  padding: 8px 12px;
  font-family: Consolas, monospace;
  font-size: 12px;
  color: #8b96b3;
  line-height: 1.75;
}

.hud b {
  color: #38e8d0;
}

.state-SIGNING {
  color: #ffd166 !important;
}

.state-COMMITTING {
  color: #ff7ac6 !important;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card {
  background: #141a2e;
  border-color: #26304b;
}

.card :deep(.el-card__header) {
  border-bottom-color: #26304b;
  padding: 10px 14px;
}

.card :deep(.el-card__body) {
  padding: 12px 14px;
}

.card-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card-title {
  font-size: 13px;
  color: #8b96b3;
  letter-spacing: 1px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.thresholds {
  margin-top: 8px;
}

.label {
  width: 52px;
  font-size: 12px;
  color: #8b96b3;
  font-family: Consolas, monospace;
}

.value {
  width: 22px;
  text-align: right;
  font-family: Consolas, monospace;
  color: #38e8d0;
}

.words {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 34px;
  align-items: center;
}

.empty {
  color: #5b6584;
  font-size: 13px;
}

.candidates {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: #ffd166;
}

.grid-preview {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed #26304b;
}

.grid-img {
  margin-top: 6px;
  width: 100%;
  max-width: 420px;
  border-radius: 8px;
  border: 1px solid #26304b;
  display: block;
}

.vocab-box {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #26304b;
}

.vocab-title {
  font-size: 12px;
  color: #8b96b3;
  margin-bottom: 8px;
}

.vocab-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 148px;
  overflow-y: auto;
}

.vocab-btn {
  margin-left: 0 !important;
}

.sentence {
  font-size: 22px;
  font-weight: 600;
  min-height: 34px;
  color: #e8ecf8;
}

.confirm-row {
  margin-top: 6px;
}

.alternative {
  margin-top: 6px;
  font-size: 13px;
  color: #8b96b3;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.other {
  margin-top: 10px;
  font-size: 14px;
  color: #ffd166;
}

.replies {
  margin-top: 10px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 240px;
  overflow-y: auto;
}

.history-item {
  padding: 8px 10px;
  border-radius: 8px;
  background: #0e1426;
  border: 1px solid #232d47;
}

.history-item.role-other {
  border-left: 3px solid #ffd166;
}

.history-item.role-me {
  border-left: 3px solid #38e8d0;
}

.history-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #8b96b3;
}

.history-role {
  font-weight: 600;
  color: #e8ecf8;
}

.history-body {
  margin-top: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.history-text {
  font-size: 14px;
  color: #e8ecf8;
}

.history-words {
  margin-top: 2px;
  font-size: 12px;
  color: #6b7699;
}

.hint {
  font-size: 12px;
  color: #5b6584;
}

/* ---------------- 大字模式：面对面共看一台设备 ---------------- */
.translate.big-mode .sentence {
  font-size: 40px;
  line-height: 1.45;
}

.translate.big-mode .history-text {
  font-size: 20px;
}

.translate.big-mode .history-meta,
.translate.big-mode .history-words {
  font-size: 14px;
}

.translate.big-mode .other {
  font-size: 22px;
}

.translate.big-mode .replies :deep(.el-button) {
  font-size: 18px;
  padding: 14px 18px;
  height: auto;
}

.translate.big-mode .words :deep(.el-tag) {
  font-size: 16px;
  height: auto;
  padding: 6px 12px;
}

/* ---------------- 响应式 ---------------- */
@media (max-width: 1100px) {
  .translate {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .translate {
    gap: 10px;
  }

  .stage {
    min-height: 200px;
  }

  .hud {
    padding: 4px 8px;
    font-size: 10px;
    line-height: 1.5;
  }

  .sentence {
    font-size: 24px;
  }

  .translate.big-mode .sentence {
    font-size: 32px;
  }

  .history-list {
    max-height: 180px;
  }

  .grid-img {
    max-width: 100%;
  }
}

.word-source {
  font-size: 11px;
  color: #38e8d0;
  font-family: Consolas, monospace;
}

.provisional-tag {
  opacity: 0.68;
  border-style: dashed;
}

.tpl-section {
  padding-bottom: 12px;
  border-bottom: 1px solid #26304b;
}

.tpl-recording-tip {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(56, 232, 208, 0.1);
  border: 1px solid rgba(56, 232, 208, 0.35);
  color: #38e8d0;
  font-size: 12px;
}

.tpl-list-box {
  margin-top: 12px;
}

.tpl-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}

.tpl-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(14, 20, 38, 0.75);
  border: 1px solid #232d47;
}

.tpl-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
