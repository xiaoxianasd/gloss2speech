"""手语识别：华为云 MaaS Qwen-VL（OpenAI 兼容接口）。

对应《工程实现方案》§3.3：
    - 输入：拼图 base64 + 场景 ID
    - 处理：拼提示词 -> 调 Qwen-VL -> temperature=0.1、超时 15s、JSON 解析失败重试 1 次
    - 输出：{"words": [], "confidence": 0, "alternatives": [[]]}

无密钥时走 Mock（按场景词表循环返回），保证前端链路可联调。
"""

from __future__ import annotations

import base64
import json
from typing import Any

from ..config import settings
from ..prompts import build_vision_prompt


class VisionService:
    def __init__(self) -> None:
        self._client = None
        self._mock_index = 0

    # ---------- 真实调用 ----------
    def _get_client(self):
        if self._client is None:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(
                base_url=settings.maas_base_url,
                api_key=settings.maas_api_key,
                timeout=settings.vision_timeout,
            )
        return self._client

    async def _call_vl(self, prompt: str, image_base64: str) -> str:
        client = self._get_client()
        kwargs: dict[str, Any] = {
            "model": settings.maas_vl_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"},
                        },
                    ],
                }
            ],
            "temperature": 0.1,
            "max_tokens": 256,
        }
        extra_body = settings.maas_extra_body()
        if extra_body:
            kwargs["extra_body"] = extra_body
        resp = await client.chat.completions.create(**kwargs)
        return resp.choices[0].message.content or ""

    # ---------- 解析与词表校验 ----------
    @staticmethod
    def _parse_response(text: str) -> dict[str, Any] | None:
        text = (text or "").strip()
        if not text:
            return None
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end <= start:
            return None
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
        words = data.get("words")
        if not isinstance(words, list):
            return None
        words = [str(word).strip() for word in words if str(word).strip()]
        confidence = data.get("confidence", 0)
        try:
            confidence = float(confidence)
        except (TypeError, ValueError):
            confidence = 0.0
        alternatives = data.get("alternatives") or []
        if not isinstance(alternatives, list):
            alternatives = []
        alternatives = [
            [str(word).strip() for word in group if str(word).strip()]
            for group in alternatives
            if isinstance(group, list)
        ]
        alternatives = [group for group in alternatives if group]
        return {
            "words": words,
            "confidence": max(0.0, min(1.0, confidence)),
            "alternatives": alternatives,
        }

    @staticmethod
    def _validate_against_vocab(parsed: dict[str, Any], scene: dict[str, Any]) -> dict[str, Any]:
        """约束识别词必须属于当前场景词表；越界词降级到候选并压低置信度。"""
        valid_vocab = {str(item["word"]).strip() for item in scene.get("vocab", []) if item.get("word")}
        if not valid_vocab:
            return parsed

        raw_words = parsed["words"]
        kept = [word for word in raw_words if word in valid_vocab]
        dropped = [word for word in raw_words if word not in valid_vocab]

        if not dropped:
            return parsed

        alternatives = list(parsed["alternatives"])
        for word in dropped:
            if [word] not in alternatives:
                alternatives.append([word])

        return {
            "words": kept,
            "confidence": min(parsed["confidence"], 0.45),
            "alternatives": alternatives,
        }

    # ---------- Mock ----------
    def _mock_recognize(self, scene: dict[str, Any]) -> dict[str, Any]:
        vocab = [item["word"] for item in scene.get("vocab", [])]
        if not vocab:
            return {"words": [], "confidence": 0.0, "alternatives": [], "mock": True}
        word = vocab[self._mock_index % len(vocab)]
        self._mock_index += 1
        fallback = [[item] for item in vocab if item != word][:2]
        return {
            "words": [word],
            "confidence": 0.86,
            "alternatives": fallback,
            "mock": True,
        }

    # ---------- 对外 ----------
    async def recognize(self, image_base64: str, scene: dict[str, Any]) -> dict[str, Any]:
        image_base64 = (image_base64 or "").strip()
        if not image_base64:
            raise ValueError("image 不能为空")
        # 去掉可能的 dataURL 前缀
        if "," in image_base64 and image_base64.startswith("data:"):
            image_base64 = image_base64.split(",", 1)[1]
        try:
            base64.b64decode(image_base64[:64] + "==="[: (-len(image_base64[:64])) % 4], validate=False)
        except Exception:  # noqa: BLE001
            raise ValueError("image 不是合法的 base64")

        if settings.use_mock("vision"):
            return self._mock_recognize(scene)

        prompt = build_vision_prompt(scene["name"], scene["vocab"])
        last_error: str | None = None
        for _ in range(2):  # 解析失败重试 1 次
            try:
                text = await self._call_vl(prompt, image_base64)
            except Exception as exc:  # noqa: BLE001
                last_error = f"调用 Qwen-VL 失败：{exc}"
                continue
            parsed = self._parse_response(text)
            if parsed is not None:
                return self._validate_against_vocab(parsed, scene)
            last_error = "视觉模型返回内容不是合法 JSON"
        raise RuntimeError(last_error or "Qwen-VL 识别失败")


vision_service = VisionService()
