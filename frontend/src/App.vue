<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand">
        <span class="logo">手语通</span>
        <span class="sub">SignBridge · 实时手语翻译</span>
      </div>
      <div class="header-right">
        <el-tag :type="serviceTagType" effect="dark" size="small" class="service-tag" @click="promptForToken">{{ serviceText }}</el-tag>
        <el-button size="small" plain class="token-btn" @click="promptForToken">{{ tokenSaved ? "口令 ✓" : "口令" }}</el-button>
      </div>
    </header>
    <main class="app-main">
      <Translate :initial-scenes="scenes" scenes-managed />
    </main>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import Translate from "./views/Translate.vue";
import { api } from "./api";

const serviceText = ref("检查后端中…");
const serviceTagType = ref("info");
const tokenSaved = ref(api.hasToken());
const scenes = ref([]);
let pendingPrompt = null;

async function checkHealth() {
  try {
    const health = await api.health();
    const services = health.services || {};
    serviceText.value = "后端 " + (services.vision === "mock" ? "Mock" : "MaaS") + " · " + (services.sis === "mock" ? "Mock" : "SIS");
    serviceTagType.value = services.vision === "mock" || services.sis === "mock" ? "warning" : "success";
    return true;
  } catch (error) {
    serviceText.value = "后端未连接（" + (error.message || error) + "）";
    serviceTagType.value = "danger";
    return false;
  }
}

async function refreshConnection() {
  try {
    const data = await api.getScenes();
    scenes.value = Array.isArray(data) ? data : (data && data.scenes) || [];
  } catch (error) {
    if (error && error.status === 401) {
      serviceText.value = "需要访问口令（点此输入）";
      serviceTagType.value = "danger";
      return false;
    }
  }
  return checkHealth();
}

function promptForToken() {
  if (pendingPrompt) return pendingPrompt;
  pendingPrompt = (async () => {
    try {
      const result = await ElMessageBox.prompt(
        "请输入后端访问口令（API_TOKEN，留空确定可清除已保存口令）：",
        "访问口令设置",
        {
          confirmButtonText: "保存",
          cancelButtonText: "取消",
          inputType: "password",
          inputValue: api.getToken(),
          inputPlaceholder: "输入口令或留空清除",
        },
      );
      const token = (result.value || "").trim();
      api.setToken(token);
      tokenSaved.value = api.hasToken();
      if (token) {
        ElMessage.success("口令已保存到本机，正在重新连接…");
      } else {
        ElMessage.info("已清除本机保存的访问口令");
      }
      await refreshConnection();
    } catch (error) {
      /* 用户取消 */
    } finally {
      pendingPrompt = null;
    }
  })();
  return pendingPrompt;
}

onMounted(async () => {
  api.onUnauthorized(() => {
    serviceText.value = "需要访问口令（点此输入）";
    serviceTagType.value = "danger";
    return promptForToken();
  });
  await refreshConnection();
});

onUnmounted(() => {
  api.onUnauthorized(null);
});
</script>
