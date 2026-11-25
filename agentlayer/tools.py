"""工具流的具体实现（快 / 近 / 慢三层）。

注意：所有 FAST 工具必须是同步、纯内存、幂等的——
它们是 0.5s 预算里唯一允许"同步阻塞"的东西。
"""

from __future__ import annotations

from typing import Any

from .contracts import ToolSpec
from .providers import LLMCompose, LLMProvider, MockLLMProvider, MockTTSProvider, TTSProvider
from .registry import ToolRegistry

#: W1 真人验收（50 词 × 3 人 × 10 次）在 hospital 原有 20 词之外追加的 30 个高频词。
#: 出处：docs/W1验收清单与实测方法.md §3。一个词对应一个 DTW 模板，所以按"一词一动作"收敛词形，
#: 不写"肚子疼""有点晕"这类复合短语（会被拆成两个模板，跨人匹配反而更差）。
W1_EXTRA_WORDS: tuple[str, ...] = (
    # 症状 / 身体部位
    "头晕", "恶心", "失眠", "心慌", "嗓子", "眼睛", "手", "脚",
    # 时间 / 频率
    "一周", "今天", "昨天", "早上", "晚上", "一直",
    # 程度 / 否定 / 疑问（手语高频功能词，缺了造句就读不通）
    "很多", "一点", "不", "有", "没有", "什么", "怎么", "可以", "需要",
    # 请求 / 动作
    "帮", "快", "慢", "等", "回家", "吃饭", "喝水",
)

SCENES: list[dict[str, Any]] = [
    {
        "id": "hospital",
        "name": "医院就诊",
        "vocab": ["你好", "谢谢", "我", "疼", "头疼", "肚子", "发烧", "咳嗽", "药", "挂号",
                  "医生", "两天", "三天", "哪里", "厕所", "多少钱", "严重", "过敏", "检查", "住院",
                  *W1_EXTRA_WORDS],
    },
    {
        "id": "bank",
        "name": "银行办理",
        "vocab": ["你好", "取钱", "存钱", "卡", "身份证", "密码", "多少", "排队", "窗口", "转账",
                  "忘了", "帮我", "谢谢"],
    },
    {
        "id": "government",
        "name": "政务大厅",
        "vocab": ["你好", "办证", "身份证", "户口", "社保", "窗口", "几号", "材料", "复印", "等一下", "谢谢"],
    },
    {
        "id": "daily",
        "name": "日常交流",
        "vocab": ["你好", "谢谢", "吃饭", "喝水", "回家", "上班", "累", "开心", "等一下", "多少钱"],
    },
]

_SCENE_BY_ID = {s["id"]: s for s in SCENES}

#: 场景化模板句（快路径造句，命中即 < 10ms）
_SCENE_RULES: dict[str, list[tuple[tuple[str, ...], str]]] = {
    "hospital": [
        (("头疼", "两天"), "医生，我头疼两天了。"),
        (("头疼",), "医生，我头疼。"),
        (("发烧",), "医生，我发烧了。"),
        (("肚子", "疼"), "医生，我肚子疼。"),
        (("挂号",), "你好，我要挂号。"),
        (("过敏",), "医生，我过敏了。"),
        (("检查",), "医生，需要做什么检查？"),
        (("多少钱",), "请问一共多少钱？"),
        (("厕所",), "请问洗手间在哪里？"),
        # —— W1 追加 30 词的造句模板：命中即出字（<10ms），不进模型 ——
        # 顺序约定：含时间/程度的复合句排在单词句前面，否则永远命中不到。
        (("头晕", "一周"), "医生，我头晕一周了。"),
        (("失眠", "一周"), "医生，我失眠一周了。"),
        (("头晕",), "医生，我头晕。"),
        (("恶心",), "医生，我有点恶心。"),
        (("失眠",), "医生，我晚上睡不着。"),
        (("心慌",), "医生，我有点心慌。"),
        # G7 兜底：只复述患者打出的词，不替患者断言"疼"
        (("嗓子",), "医生，我嗓子不舒服。"),
        (("眼睛",), "医生，我眼睛不舒服。"),
        (("手",), "医生，我的手不舒服。"),
        (("脚",), "医生，我的脚不舒服。"),
        (("一周",), "已经一周了。"),
        (("今天", "早上"), "今天早上开始的。"),
        (("今天",), "今天。"),
        (("昨天",), "昨天开始的。"),
        (("早上",), "今天早上开始的。"),
        (("晚上",), "晚上。"),
        (("一直",), "一直这样。"),
        (("很多",), "已经很多天了。"),
        (("一点",), "有一点。"),
        # "没有" 必须排在 "有" 前面，否则被单字规则抢先命中
        (("没有",), "没有。"),
        (("不",), "不是。"),
        (("有",), "有。"),
        (("什么",), "你说什么？"),
        (("怎么",), "怎么办？"),
        (("可以",), "可以吗？"),
        (("需要",), "请问需要什么帮助？"),
        (("帮",), "请帮帮我。"),
        (("快",), "请快一点。"),
        (("慢",), "请慢一点。"),
        (("等",), "请等一下。"),
        (("回家",), "我想回家。"),
        (("吃饭",), "我想吃饭。"),
        (("喝水",), "我想喝水。"),
    ],
    "bank": [
        (("取钱",), "你好，我要取钱。"),
        (("存钱",), "你好，我要存钱。"),
        (("卡", "忘了"), "我的卡密码忘了，怎么办？"),
        (("排队",), "请问需要排队吗？"),
    ],
    "government": [
        (("办证", "身份证"), "你好，我要补办身份证。"),
        (("社保",), "你好，我要办社保。"),
        (("材料",), "请问需要带什么材料？"),
    ],
    "daily": [
        (("吃饭",), "一起去吃饭吗？"),
        (("回家",), "我要回家了。"),
        (("多少钱",), "这个多少钱？"),
    ],
}

EMERGENCY_WORDS = ("救命", "报警", "胸痛", "呼吸困难", "流血", "自杀")
EMERGENCY_TEXT = "请帮帮我，我需要紧急救助，请马上叫医生或拨打 120。"


def scene_vocab(scene_id: str) -> list[str]:
    scene = _SCENE_BY_ID.get(scene_id) or SCENES[0]
    return list(scene["vocab"])


def compose_template(words: list[str], scene_id: str = "hospital") -> str:
    """FAST：模板 + 规则造句，P95 < 10ms。"""
    cleaned: list[str] = []
    for w in words:
        if w and (not cleaned or cleaned[-1] != w):
            cleaned.append(w)
    if not cleaned:
        return ""
    joined = "".join(cleaned)
    for pattern, sentence in _SCENE_RULES.get(scene_id, []):
        if all(p in joined for p in pattern):
            return sentence
    # 通用兜底：去重后用逗号连接（保证一定能出字，不阻塞）
    return "，".join(cleaned) + "。"


def compose_fallback_llm(words: list[str], scene_id: str = "hospital") -> LLMCompose:
    """FAST：LLM 超时后的同构兜底（返回类型与 compose.cot 一致，避免调用方分支）。"""
    sentence = compose_template(words, scene_id)
    return LLMCompose(sentence=sentence, alternative="", confidence=0.5,
                      need_confirm=True, reasoning={"degraded": "template_fallback"}, provider="fallback")


def is_emergency(words: list[str]) -> bool:
    joined = "".join(words)
    return any(w in joined for w in EMERGENCY_WORDS)


def build_registry(
    llm: LLMProvider | None = None,
    tts: TTSProvider | None = None,
) -> ToolRegistry:
    llm = llm or MockLLMProvider()
    tts = tts or MockTTSProvider()
    reg = ToolRegistry()

    # ---------- FAST（同步，< 30ms） ----------
    reg.register(ToolSpec(
        name="scene.vocab", tier="fast", description="取场景词表",
        fn=scene_vocab, timeout_ms=5, input_schema={"scene_id": "str"},
    ))
    reg.register(ToolSpec(
        name="compose.template", tier="fast", description="模板/规则造句",
        fn=compose_template, timeout_ms=10, input_schema={"words": "list[str]", "scene_id": "str"},
        emits=("sentence.fast",),
    ))
    reg.register(ToolSpec(
        name="compose.fallback_llm", tier="fast", description="LLM 兜底的同构造句",
        fn=compose_fallback_llm, timeout_ms=10, input_schema={"words": "list[str]", "scene_id": "str"},
    ))
    reg.register(ToolSpec(
        name="emergency.match", tier="fast", description="紧急词规则命中（不走模型）",
        fn=is_emergency, timeout_ms=2, input_schema={"words": "list[str]"},
        emits=("emergency",),
    ))

    # ---------- NEAR（异步，< 300ms，可并行） ----------
    async def tts_stream(text: str = "") -> Any:
        return await tts.synthesize(text=text)

    async def rag_lookup(query: str = "") -> list[str]:
        # 原型用静态知识；生产替换为向量检索（< 50ms）
        knowledge = {
            "挂号": ["一楼大厅自助机可挂号", "也支持手机挂号"],
            "厕所": ["洗手间在走廊尽头左侧"],
            "医保": ["医保窗口在 3 号"],
        }
        return [v for k, v in knowledge.items() if k in query][:2]

    reg.register(ToolSpec(
        name="tts.stream", tier="near", description="流式语音合成（首包）",
        fn=tts_stream, timeout_ms=280, input_schema={"text": "str"}, emits=("audio.fast",),
    ))
    reg.register(ToolSpec(
        name="rag.lookup", tier="near", description="场景知识检索",
        fn=rag_lookup, timeout_ms=80, input_schema={"query": "str"},
    ))

    # ---------- SLOW（异步，< 3s，可取消） ----------
    async def compose_cot(words: list[str] | None = None, scene_id: str = "hospital",
                          history: list[dict] | None = None, topk: list[list[str]] | None = None) -> Any:
        return await llm.compose_cot(words=words or [], scene_id=scene_id,
                                     history=history or [], topk=topk)

    reg.register(ToolSpec(
        name="compose.cot", tier="slow", description="结构化思维链润色（流式，有截止时间）",
        fn=compose_cot, timeout_ms=900, fallback="compose.fallback_llm",
        input_schema={"words": "list[str]", "scene_id": "str", "history": "list"},
        emits=("sentence.refined",),
    ))

    async def vision_verify(scene_id: str = "hospital", topk: list[list[str]] | None = None) -> dict:
        # 原型：异步复核，生产替换为 Qwen-VL（1–3s，允许慢）
        import asyncio
        await asyncio.sleep(0.02)
        best = (topk or [[""]])[0]
        return {"verified": best[0] if best else "", "confidence": 0.7, "source": "mock-vlm"}

    reg.register(ToolSpec(
        name="vision.verify", tier="slow", description="Qwen-VL 异步复核低置信词",
        fn=vision_verify, timeout_ms=2500, idempotent=True,
        side_effect="external_call", input_schema={"scene_id": "str", "topk": "list"},
    ))

    return reg
