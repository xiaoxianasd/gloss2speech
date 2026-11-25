"""造句 / 快捷回复：华为云 MaaS DeepSeek（OpenAI 兼容，stream=True）。

对应《工程实现方案》§3.5 / §3.7，并融合双平面安全护栏：
    - 紧急求助零延迟旁路：命中紧急词不调 LLM，直接播报标准化求助语
    - 医疗防幻觉与核心词覆盖护栏：拦截未提及药物/诊断与关键手语词遗漏
    - /api/compose：两段式流式输出（首行译文直出 + 末尾 JSON）
    - /api/quick-reply：对方的话 -> 3 个快捷回复

无密钥时走 Mock：按安全规则生成句子并分块"流式"吐出，保证前端体验一致。
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, AsyncIterator

from ..config import settings
from ..prompts import build_compose_prompt, build_quick_reply_prompt

EMERGENCY_WORDS = ("急救", "救命", "报警", "胸痛", "呼吸困难", "流血", "昏迷", "休克")
EMERGENCY_TEXT = "请帮帮我，我需要紧急救助，请马上叫医生或拨打 120。"

HIGH_RISK_WORDS = (
    "疼", "痛", "发烧", "咳嗽", "药", "过敏", "输液", "检查", "住院",
    "化验", "拍片", "严重", "挂失", "转账", "密码", "身份证", "办证", "多少钱", "费用",
)

MEDICAL_FORBIDDEN_INFERRED_TERMS = (
    "药物", "青霉素", "阿莫西林", "感冒药", "止痛药", "消炎药", "抗生素", "退烧药",
    "手术", "发炎", "感染", "心脏", "血压", "高血压", "糖尿病", "癌症", "骨折",
)

_POLITE_WORDS = {"你好", "谢谢", "我", "你"}


def is_emergency(words: list[str]) -> bool:
    joined = "".join(str(w).strip() for w in words if str(w).strip())
    return any(term in joined for term in EMERGENCY_WORDS)


def safe_template_sentence(words: list[str], scene_id: str = "") -> tuple[str, str]:
    """确定性安全模板造句（零幻觉兜底与 Mock 共用）。"""
    cleaned: list[str] = []
    for raw in words:
        word = str(raw).strip()
        if word and (not cleaned or cleaned[-1] != word):
            cleaned.append(word)
    if not cleaned:
        return "你好，请问需要什么帮助？", "请问有什么事？"

    core_words = list(dict.fromkeys(w for w in cleaned if w not in _POLITE_WORDS))
    joined = "".join(cleaned)
    rules = [
        (("头疼", "两天"), "医生，我头疼两天了。", "医生，我头疼，已经两天了。"),
        (("头疼",), "医生，我头疼。", "医生，我的头很疼。"),
        (("发烧",), "医生，我发烧了。", "医生，我好像发烧了。"),
        (("肚子疼",), "医生，我肚子疼。", "医生，我的肚子很疼。"),
        (("咳嗽",), "医生，我咳嗽。", "医生，我有点咳嗽。"),
        (("过敏",), "医生，我过敏了。", "医生，我有过敏情况。"),
        (("化验",), "医生，请问需要做化验吗？", "请问需要化验吗？"),
        (("拍片",), "医生，请问需要拍片吗？", "请问需要拍片检查吗？"),
        (("住院",), "医生，请问需要住院吗？", "请问需要办理住院吗？"),
        (("出院",), "医生，请问什么时候可以出院？", "请问可以办理出院了吗？"),
        (("输液",), "医生，请问需要输液吗？", "请问需要打点滴输液吗？"),
        (("挂号",), "你好，我要挂号。", "您好，我想挂一个号。"),
        (("药",), "医生，请给我开药。", "医生，我需要拿药。"),
        (("厕所",), "请问厕所在哪里？", "请问洗手间在哪里？"),
        (("多少钱",), "请问一共多少钱？", "这个要多少钱？"),
        (("取钱",), "你好，我要取钱。", "您好，我想取一些现金。"),
        (("存钱",), "你好，我要存钱。", "您好，我想存钱。"),
        (("挂失",), "你好，我要办理挂失。", "您好，我需要办理挂失。"),
        (("办证", "身份证"), "你好，我要办证，办理身份证。", "您好，我需要办理身份证业务。"),
        (("社保",), "你好，我要办社保。", "您好，我想办理社保业务。"),
        (("材料",), "请问需要带什么材料？", "请问需要准备哪些材料？"),
        (("吃饭",), "一起去吃饭吗？", "我们去吃饭吧。"),
        (("回家",), "我要回家了。", "我先回家了。"),
    ]
    for pattern, sentence_text, alternative_text in rules:
        if all(word in joined for word in pattern) and all(cw in sentence_text for cw in core_words):
            return sentence_text, alternative_text
    return "，".join(cleaned) + "。", "".join(cleaned) + "。"


def guard_compose(
    words: list[str],
    sentence: str,
    scene_id: str = "",
    history: list[dict[str, Any]] | None = None,
) -> tuple[str, bool, str]:
    """核心词覆盖与医疗防幻觉护栏。返回 (最终句, 是否触发护栏, 原因)。"""
    text = (sentence or "").strip()
    if not text:
        return safe_template_sentence(words, scene_id)[0], True, "译文为空"

    core = list(dict.fromkeys(str(w).strip() for w in words if str(w).strip() and str(w).strip() not in _POLITE_WORDS))
    if core:
        missing = [w for w in core if w not in text]
        max_missing = 0 if len(core) <= 3 else len(core) // 4
        if len(missing) > max_missing:
            return (
                safe_template_sentence(words, scene_id)[0],
                True,
                f"核心手语词遗漏：{'、'.join(missing)}",
            )

    joined_words = "".join(str(w).strip() for w in words if str(w).strip())
    medical_markers = ("疼", "痛", "发烧", "咳嗽", "药", "过敏", "输液", "检查", "住院", "化验", "拍片", "医生", "护士", "医院")
    is_medical = (scene_id == "hospital") or any(marker in joined_words for marker in medical_markers)
    if is_medical:
        history_text = "".join(str(turn.get("text", "")) for turn in (history or [])[-5:])
        allowed_text = joined_words + history_text
        for term in MEDICAL_FORBIDDEN_INFERRED_TERMS:
            if term in text and term not in allowed_text:
                return (
                    safe_template_sentence(words, scene_id)[0],
                    True,
                    f"拦截未提及医疗信息：{term}",
                )
        if len(text) > max(26, len(joined_words) * 4):
            return safe_template_sentence(words, scene_id)[0], True, "译文过度扩写"

    return text, False, ""


class _SentenceExtractor:
    """从流式 JSON 文本里增量提取 "sentence" 字段，只把句子内容推给前端。"""

    def __init__(self) -> None:
        self._buffer = ""
        self._pos = 0
        self._started = False
        self._finished = False
        self.text = ""

    def feed(self, chunk: str) -> str:
        if self._finished or not chunk:
            return ""
        self._buffer += chunk
        if not self._started:
            match = re.search(r'"sentence"\s*:\s*"', self._buffer)
            if not match:
                return ""
            self._pos = match.end()
            self._started = True
        out: list[str] = []
        escaping = {'"': '"', "n": "\n", "t": "\t", "\\": "\\", "/": "/"}
        while self._pos < len(self._buffer):
            char = self._buffer[self._pos]
            if char == "\\":
                if self._pos + 1 >= len(self._buffer):
                    break
                nxt = self._buffer[self._pos + 1]
                out.append(escaping.get(nxt, nxt))
                self._pos += 2
                continue
            if char == '"':
                self._finished = True
                self._pos += 1
                break
            out.append(char)
            self._pos += 1
        piece = "".join(out)
        self.text += piece
        return piece


class _DualModeSentenceStreamer:
    """兼容"第一行直出 + 末尾 JSON"与"纯 JSON（任意字段顺序）"的流式提取器。"""

    def __init__(self) -> None:
        self._mode: str | None = None
        self._stopped = False
        self._raw = ""
        self._json_extractor = _SentenceExtractor()
        self.text = ""

    def _consume_line(self, text: str) -> str:
        if self._stopped or not text:
            return ""
        stop_indices = [idx for idx in (text.find("\n"), text.find("\r"), text.find("{")) if idx >= 0]
        if stop_indices:
            end = min(stop_indices)
            piece = text[:end]
            self._stopped = True
        else:
            piece = text
        self.text += piece
        return piece

    def feed(self, chunk: str) -> str:
        if not chunk:
            return ""
        self._raw += chunk
        if self._mode is None:
            stripped = self._raw.lstrip()
            if not stripped:
                return ""
            if stripped[0] in ("{", "`"):
                self._mode = "json"
                piece = self._json_extractor.feed(stripped)
                self.text += piece
                return piece
            self._mode = "line"
            return self._consume_line(stripped)

        if self._mode == "json":
            piece = self._json_extractor.feed(chunk)
            self.text += piece
            return piece
        return self._consume_line(chunk)


def _parse_json_object(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return {}
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _parse_compose_output(raw: str, words: list[str]) -> dict[str, Any]:
    """容错解析两段式或纯 JSON 造句输出。"""
    text = (raw or "").strip()
    parsed = _parse_json_object(text)

    prefix_end = text.find("{")
    prefix = text[:prefix_end].strip() if prefix_end >= 0 else text
    first_line = ""
    for line in prefix.splitlines():
        candidate = line.strip()
        if not candidate or candidate.startswith("```"):
            continue
        first_line = candidate.strip('"“”')
        break

    sentence = str(parsed.get("sentence") or "").strip() or first_line or ("".join(words) + "。")
    alternative = str(parsed.get("alternative") or "").strip()
    need_confirm = bool(parsed.get("need_confirm", False))
    return {
        "sentence": sentence,
        "alternative": alternative,
        "need_confirm": need_confirm,
    }


class LLMService:
    def __init__(self) -> None:
        self._client = None

    def _get_client(self):
        if self._client is None:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(
                base_url=settings.maas_base_url,
                api_key=settings.maas_api_key,
                timeout=30.0,
            )
        return self._client

    # ---------------- compose ----------------
    async def compose_stream(
        self,
        words: list[str],
        scene_name: str,
        history: list[dict[str, Any]] | None,
        scene_id: str = "",
    ) -> AsyncIterator[dict[str, Any]]:
        if is_emergency(words):
            for index in range(0, len(EMERGENCY_TEXT), 4):
                yield {"type": "delta", "text": EMERGENCY_TEXT[index : index + 4]}
            yield {
                "type": "done",
                "sentence": EMERGENCY_TEXT,
                "alternative": "",
                "emergency": True,
                "need_confirm": False,
                "guard_triggered": False,
                "guard_reason": "",
            }
            return

        joined_words = "".join(str(w).strip() for w in words if str(w).strip())
        high_risk = any(marker in joined_words for marker in HIGH_RISK_WORDS)

        if settings.use_mock("llm"):
            async for item in self._mock_compose_stream(words, scene_id, history, high_risk):
                yield item
            return

        prompt = build_compose_prompt(words, scene_name, history)
        client = self._get_client()
        kwargs: dict[str, Any] = {
            "model": settings.maas_llm_model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.1,
            "max_tokens": 300,
            "stream": True,
        }
        extra_body = settings.maas_extra_body()
        if extra_body:
            kwargs["extra_body"] = extra_body
        stream = await client.chat.completions.create(**kwargs)
        streamer = _DualModeSentenceStreamer()
        raw_parts: list[str] = []
        async for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if not delta:
                continue
            raw_parts.append(delta)
            piece = streamer.feed(delta)
            if piece:
                yield {"type": "delta", "text": piece}

        raw = "".join(raw_parts)
        parsed = _parse_compose_output(raw, words)
        candidate = parsed["sentence"] or streamer.text or ("".join(words) + "。")
        final_sentence, guard_triggered, guard_reason = guard_compose(words, candidate, scene_id, history)
        alternative = safe_template_sentence(words, scene_id)[1] if guard_triggered else parsed["alternative"]
        need_confirm = bool(parsed["need_confirm"] or guard_triggered or high_risk)
        yield {
            "type": "done",
            "sentence": final_sentence,
            "alternative": alternative,
            "emergency": False,
            "need_confirm": need_confirm,
            "guard_triggered": guard_triggered,
            "guard_reason": guard_reason,
        }

    async def _mock_compose_stream(
        self,
        words: list[str],
        scene_id: str,
        history: list[dict[str, Any]] | None,
        high_risk: bool,
    ) -> AsyncIterator[dict[str, Any]]:
        sentence, alternative = safe_template_sentence(words, scene_id)
        final_sentence, guard_triggered, guard_reason = guard_compose(words, sentence, scene_id, history)
        for index in range(0, len(final_sentence), 3):
            await asyncio.sleep(0.02)
            yield {"type": "delta", "text": final_sentence[index : index + 3]}
        yield {
            "type": "done",
            "sentence": final_sentence,
            "alternative": alternative,
            "emergency": False,
            "need_confirm": bool(guard_triggered or high_risk),
            "guard_triggered": guard_triggered,
            "guard_reason": guard_reason,
        }

    # ---------------- quick reply ----------------
    async def quick_reply(self, text: str, scene_name: str) -> list[str]:
        if settings.use_mock("llm"):
            await asyncio.sleep(0.05)
            return self._mock_quick_reply(text)

        prompt = build_quick_reply_prompt(text, scene_name)
        client = self._get_client()
        kwargs: dict[str, Any] = {
            "model": settings.maas_llm_model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3,
            "max_tokens": 160,
        }
        extra_body = settings.maas_extra_body()
        if extra_body:
            kwargs["extra_body"] = extra_body
        resp = await client.chat.completions.create(**kwargs)
        raw = resp.choices[0].message.content or ""
        start = raw.find("[")
        end = raw.rfind("]")
        if start != -1 and end > start:
            try:
                replies = json.loads(raw[start : end + 1])
            except json.JSONDecodeError:
                replies = []
            if isinstance(replies, list):
                cleaned = [str(item).strip()[:12] for item in replies if str(item).strip()]
                if cleaned:
                    return cleaned[:3]
        return ["好的，谢谢。", "请再说一遍。", "我需要帮助。"]

    @staticmethod
    def _mock_quick_reply(text: str) -> list[str]:
        if re.search(r"哪里不舒服|怎么不舒服|什么症状", text):
            return ["我头疼", "我发烧", "我肚子疼"]
        if re.search(r"姓名|名字|怎么称呼", text):
            return ["我叫王明", "请再说一遍", "我写字给你看"]
        if re.search(r"多少|几个月|几天", text):
            return ["两天了", "一个星期", "刚刚开始"]
        if re.search(r"带了吗|材料|证件", text):
            return ["带了", "没有带", "我去拿"]
        return ["好的，谢谢。", "请再说一遍。", "我需要帮助。"]


llm_service = LLMService()
