"""配置：从项目根目录 .env 读取华为云 MaaS / SIS 凭据。

MOCK_MODE:
    auto （默认）—— 有对应密钥就用真实服务，没有就自动 Mock（保证无密钥也能跑通演示）
    1             —— 强制 Mock
    0             —— 强制真实（缺密钥直接报错，避免"以为在调云、其实在 Mock"）
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"


def _load_env_file() -> None:
    if not ENV_PATH.exists():
        return
    for raw in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file()


class Settings:
    def __init__(self) -> None:
        self.maas_base_url = os.getenv("MAAS_BASE_URL", "https://api.modelarts-maas.com/v1").strip()
        self.maas_api_key = os.getenv("MAAS_API_KEY", "").strip()
        self.maas_vl_model = os.getenv("MAAS_VL_MODEL", "qwen2.5-vl-72b").strip()
        self.maas_llm_model = os.getenv("MAAS_LLM_MODEL", "deepseek-v3").strip()
        self.maas_disable_thinking = os.getenv("MAAS_DISABLE_THINKING", "1").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }

        self.hw_ak = os.getenv("HW_AK", "").strip()
        self.hw_sk = os.getenv("HW_SK", "").strip()
        self.hw_project_id = os.getenv("HW_PROJECT_ID", "").strip()
        self.sis_region = os.getenv("SIS_REGION", "cn-north-4").strip()
        self.sis_tts_voice = os.getenv("SIS_TTS_VOICE", "chinese_xiaoyan_common").strip()
        self.sis_asr_property = os.getenv("SIS_ASR_PROPERTY", "chinese_16k_common").strip()

        self.mock_mode = os.getenv("MOCK_MODE", "auto").strip().lower()
        self.vision_timeout = float(os.getenv("VISION_TIMEOUT", "15"))
        self.scene_default = os.getenv("SCENE_DEFAULT", "hospital")

        # ---- 公网防护（backend/guard.py） ----
        # API_TOKEN 非空时，/api/* 必须带 X-API-Token 头（/api/health 除外，便于探活）。
        # 本地开发留空即关闭；上公网前必须设置，否则 MaaS/SIS 额度会被刷爆。
        self.api_token = os.getenv("API_TOKEN", "").strip()
        # 每客户端 IP 每分钟 /api/* 请求上限（滑窗），0 表示关闭限流。
        self.rate_limit_per_minute = int(os.getenv("RATE_LIMIT_PER_MINUTE", "120"))

    # ---- 各服务的可用性 ----
    @property
    def vision_ready(self) -> bool:
        return bool(self.maas_api_key)

    @property
    def llm_ready(self) -> bool:
        return bool(self.maas_api_key)

    @property
    def sis_ready(self) -> bool:
        return bool(self.hw_ak and self.hw_sk and self.hw_project_id)

    def use_mock(self, service: str) -> bool:
        if self.mock_mode in {"1", "true", "yes", "on"}:
            return True
        if self.mock_mode in {"0", "false", "no", "off"}:
            ready = {
                "vision": self.vision_ready,
                "llm": self.llm_ready,
                "sis": self.sis_ready,
            }.get(service, False)
            if not ready:
                raise RuntimeError(
                    f"MOCK_MODE=0（强制真实）但 {service} 的密钥未配置；"
                    "请在 .env 填写 MAAS_API_KEY / HW_AK / HW_SK / HW_PROJECT_ID"
                )
            return False
        return not {
            "vision": self.vision_ready,
            "llm": self.llm_ready,
            "sis": self.sis_ready,
        }.get(service, False)

    def maas_extra_body(self) -> dict | None:
        return {"thinking": {"type": "disabled"}} if self.maas_disable_thinking else None

    def describe(self) -> dict:
        return {
            "maas_base_url": self.maas_base_url,
            "maas_vl_model": self.maas_vl_model,
            "maas_llm_model": self.maas_llm_model,
            "sis_region": self.sis_region,
            "mock_mode": self.mock_mode,
            "vision": "mock" if self.use_mock("vision") else "maas",
            "llm": "mock" if self.use_mock("llm") else "maas",
            "sis": "mock" if self.use_mock("sis") else "hwcloud",
        }


settings = Settings()
