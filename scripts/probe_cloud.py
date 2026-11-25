"""云端真实探测：MaaS LLM/VL 与 SIS TTS/ASR 的延迟 P50/P95/P99（W2/W3 用真实值替换 Mock 假设）。

用法（项目根目录，先 cp .env.example .env 填好密钥）：
    python scripts/probe_cloud.py --runs 5            # 只测 LLM 造句
    python scripts/probe_cloud.py --runs 5 --vision   # 加测 Qwen-VL 视觉识别
    python scripts/probe_cloud.py --runs 5 --tts      # 加测 SIS 语音合成
    python scripts/probe_cloud.py --runs 5 --asr      # 加测 SIS 一句话识别
    python scripts/probe_cloud.py --runs 5 --all      # 全部

无对应密钥/依赖的探测会安全跳过并打印原因，不会报错中断其他探测。
结果写入 reports/cloud_probe.md，用来替换架构文档里的"假设值"。
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import platform
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # 允许 import backend / agentlayer
REPORT = ROOT / "reports" / "cloud_probe.md"

#: 预算（与 docs 保持一致）
LLM_TTFT_BUDGET_MS = 350.0     # L4：判停后 600ms 内要看到润色句
LLM_TOTAL_BUDGET_MS = 900.0    # compose.cot 的 deadline
VL_TOTAL_BUDGET_MS = 3000.0    # 每词识别 1.5–3s 的经验上限
TTS_BUDGET_MS = 300.0          # L2/L5 的关键（流式首包目标；run_tts 为整段返回，见报告注释）
ASR_BUDGET_MS = 2000.0         # 一句话识别经验上限

#: 16×16 白色标准 JPEG（仅用于 VL 连通性/延迟探测，不用于准确率评估）
_TINY_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/"
    "2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAQABADASIAAhEBAxEB/"
    "8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2Jy"
    "ggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLD"
    "xMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3"
    "AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6"
    "goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD0CiiigD//2Q=="
)

PROBE_TEXT = "医生，我头疼两天了。"


def load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


def pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round((p / 100.0) * (len(ordered) - 1))))
    return float(ordered[idx])


def summarize(rows: list[dict], key: str) -> dict:
    """从成功样本提取统计量（P50/P95/P99/min/max）。"""
    values = [r[key] for r in rows if key in r and "error" not in r]
    if not values:
        return {}
    return {
        "p50": pct(values, 50),
        "p95": pct(values, 95),
        "p99": pct(values, 99),
        "min": min(values),
        "max": max(values),
        "samples": [round(v, 1) for v in values],
    }


def _maas_client():
    from openai import AsyncOpenAI

    return AsyncOpenAI(
        base_url=os.getenv("MAAS_BASE_URL", "https://api.modelarts-maas.com/v1"),
        api_key=os.getenv("MAAS_API_KEY", ""),
        timeout=30.0,
    )


def _maas_extra_body() -> dict | None:
    disable = os.getenv("MAAS_DISABLE_THINKING", "1").strip().lower() in {"1", "true", "yes", "on"}
    return {"thinking": {"type": "disabled"}} if disable else None


async def probe_llm(runs: int) -> dict:
    """MaaS 文本模型结构化 CoT：TTFT / 总耗时。"""
    try:
        import openai  # noqa: F401
    except ImportError:
        return {"ok": False, "reason": "未安装 openai：pip install openai（华为云 MaaS 兼容 OpenAI 协议）"}
    if not os.getenv("MAAS_API_KEY"):
        return {"ok": False, "reason": "MAAS_API_KEY 未配置"}

    from agentlayer.prompts import build_cot_messages

    client = _maas_client()
    model = os.getenv("MAAS_LLM_MODEL", "deepseek-v3")
    messages = build_cot_messages(words=["我", "头疼", "两天"], scene_id="hospital")

    rows: list[dict] = []
    for _ in range(runs):
        started = time.perf_counter()
        ttft = None
        text_parts: list[str] = []
        try:
            kwargs = {
                "model": model,
                "messages": messages,
                "temperature": 0.1,
                "max_tokens": 200,
                "stream": True,
            }
            extra_body = _maas_extra_body()
            if extra_body:
                kwargs["extra_body"] = extra_body
            stream = await client.chat.completions.create(**kwargs)
            async for chunk in stream:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    if ttft is None:
                        ttft = (time.perf_counter() - started) * 1000.0
                    text_parts.append(delta)
        except Exception as exc:  # noqa: BLE001
            rows.append({"error": f"{type(exc).__name__}: {exc}"})
            continue
        total = (time.perf_counter() - started) * 1000.0
        rows.append({"ttft": ttft or total, "total": total, "chars": len("".join(text_parts))})

    ok_rows = [r for r in rows if "error" not in r]
    if not ok_rows:
        return {"ok": False, "reason": "全部请求失败", "rows": rows}
    ttft = summarize(rows, "ttft")
    total = summarize(rows, "total")
    return {
        "ok": True, "model": model, "runs": len(ok_rows), "errors": len(rows) - len(ok_rows),
        "ttft": ttft, "total": total,
        "pass": ttft.get("p95", 1e9) <= LLM_TTFT_BUDGET_MS and total.get("p95", 1e9) <= LLM_TOTAL_BUDGET_MS,
    }


async def probe_vision(runs: int) -> dict:
    """MaaS 视觉模型（Qwen-VL）：拼图识别 TTFT / 总耗时（连通性探测，非准确率）。"""
    try:
        import openai  # noqa: F401
    except ImportError:
        return {"ok": False, "reason": "未安装 openai：pip install openai"}
    if not os.getenv("MAAS_API_KEY"):
        return {"ok": False, "reason": "MAAS_API_KEY 未配置"}

    client = _maas_client()
    model = os.getenv("MAAS_VL_MODEL", "qwen2.5-vl-72b")
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + _TINY_JPEG_B64}},
                {"type": "text", "text": "描述这张图片。只输出 JSON：{\"description\":\"...\"}"},
            ],
        }
    ]

    rows: list[dict] = []
    for _ in range(runs):
        started = time.perf_counter()
        ttft = None
        try:
            kwargs = {
                "model": model,
                "messages": messages,
                "temperature": 0.1,
                "max_tokens": 120,
                "stream": True,
            }
            extra_body = _maas_extra_body()
            if extra_body:
                kwargs["extra_body"] = extra_body
            stream = await client.chat.completions.create(**kwargs)
            async for chunk in stream:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta and ttft is None:
                    ttft = (time.perf_counter() - started) * 1000.0
        except Exception as exc:  # noqa: BLE001
            rows.append({"error": f"{type(exc).__name__}: {exc}"})
            continue
        total = (time.perf_counter() - started) * 1000.0
        rows.append({"ttft": ttft or total, "total": total})

    ok_rows = [r for r in rows if "error" not in r]
    if not ok_rows:
        return {"ok": False, "reason": "全部请求失败", "rows": rows}
    ttft = summarize(rows, "ttft")
    total = summarize(rows, "total")
    return {
        "ok": True, "model": model, "runs": len(ok_rows), "errors": len(rows) - len(ok_rows),
        "ttft": ttft, "total": total,
        "pass": total.get("p95", 1e9) <= VL_TOTAL_BUDGET_MS,
    }


def _sis_client():
    from huaweicloudsdkcore.auth.credentials import BasicCredentials
    from huaweicloudsdksis.v1 import SisClient
    from huaweicloudsdksis.v1.region.sis_region import SisRegion

    credentials = BasicCredentials(
        os.getenv("HW_AK", ""),
        os.getenv("HW_SK", ""),
        os.getenv("HW_PROJECT_ID", ""),
    )
    return (
        SisClient.new_builder()
        .with_credentials(credentials)
        .with_region(SisRegion.value_of(os.getenv("SIS_REGION", "cn-north-4")))
        .build()
    )


def _sis_not_ready() -> str | None:
    try:
        import huaweicloudsdkcore  # noqa: F401
        import huaweicloudsdksis  # noqa: F401
    except ImportError as exc:
        return f"未安装 SIS SDK（{exc}）：pip install huaweicloudsdkcore huaweicloudsdksis"
    if not os.getenv("HW_AK") or not os.getenv("HW_SK"):
        return "HW_AK/HW_SK 未配置"
    return None


def probe_tts(runs: int) -> dict:
    """SIS 语音合成：run_tts 整段返回耗时（流式首包会低于此值，属保守上界）。"""
    reason = _sis_not_ready()
    if reason:
        return {"ok": False, "reason": reason}

    from backend.services.sis import _build_tts_request

    client = _sis_client()
    rows: list[dict] = []
    for _ in range(runs):
        started = time.perf_counter()
        try:
            response = client.run_tts(_build_tts_request(PROBE_TEXT))
            audio = getattr(response.result, "data", None) if response.result is not None else None
            if not audio:
                raise RuntimeError("SIS TTS 未返回有效音频数据")
            size = len(audio) if isinstance(audio, (bytes, str)) else 0
            rows.append({"ttfb": (time.perf_counter() - started) * 1000.0, "bytes": size})
        except Exception as exc:  # noqa: BLE001
            rows.append({"error": f"{type(exc).__name__}: {exc}"})

    ok_rows = [r for r in rows if "error" not in r]
    if not ok_rows:
        return {"ok": False, "reason": "全部请求失败", "rows": rows}
    ttfb = summarize(rows, "ttfb")
    return {
        "ok": True, "runs": len(ok_rows), "errors": len(rows) - len(ok_rows),
        "voice": os.getenv("SIS_TTS_VOICE", "chinese_xiaoyan_common"),
        "ttfb": ttfb, "bytes": ok_rows[-1].get("bytes", 0),
        "pass": ttfb.get("p95", 1e9) <= TTS_BUDGET_MS,
    }


def probe_asr(runs: int) -> dict:
    """SIS 一句话识别：1.5s 静音 wav 的识别耗时（静音文本为空属正常，只测链路延迟）。"""
    reason = _sis_not_ready()
    if reason:
        return {"ok": False, "reason": reason}

    from backend.services.sis import _build_asr_request, _silent_wav_base64

    client = _sis_client()
    audio_b64 = _silent_wav_base64(1500)
    rows: list[dict] = []
    for _ in range(runs):
        started = time.perf_counter()
        try:
            response = client.recognize_short_audio(_build_asr_request(audio_b64))
            text = ""
            if response.result is not None:
                text = getattr(response.result, "text", "") or ""
            rows.append({"total": (time.perf_counter() - started) * 1000.0, "text": text})
        except Exception as exc:  # noqa: BLE001
            rows.append({"error": f"{type(exc).__name__}: {exc}"})

    ok_rows = [r for r in rows if "error" not in r]
    if not ok_rows:
        return {"ok": False, "reason": "全部请求失败", "rows": rows}
    total = summarize(rows, "total")
    return {
        "ok": True, "runs": len(ok_rows), "errors": len(rows) - len(ok_rows),
        "property": os.getenv("SIS_ASR_PROPERTY", "chinese_16k_common"),
        "total": total,
        "pass": total.get("p95", 1e9) <= ASR_BUDGET_MS,
    }


def _fmt_stats(stats: dict, budget: float) -> str:
    return (
        f"P50 **{stats['p50']:.0f}ms** / P95 **{stats['p95']:.0f}ms** / P99 {stats['p99']:.0f}ms"
        f"（min {stats['min']:.0f} / max {stats['max']:.0f}，预算 ≤ {budget:.0f}ms）"
    )


def write_report(results: dict[str, dict | None], runs: int) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    env_hint = "cp .env.example .env"
    lines = [
        "# 云端真实探测报告",
        "",
        f"> 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"> 机器：{platform.platform()}",
        f"> 试次：{runs}",
        "",
    ]

    def section(title: str, result: dict | None, body_ok, budget_hint: str) -> None:
        lines.append(f"## {title}")
        lines.append("")
        if result and result.get("ok"):
            lines.extend(body_ok(result))
        else:
            reason = (result or {}).get("reason", "未启用对应开关")
            rows = (result or {}).get("rows") or []
            lines.append(f"- 状态：**未执行**（{reason}）")
            for row in rows[:3]:
                if "error" in row:
                    lines.append(f"  - `{row['error']}`")
            lines.append(f"- 配置方式：{env_hint}，{budget_hint}")
        lines.append("")

    llm = results.get("llm")
    section(
        "1. MaaS 结构化 CoT 造句（LLM）",
        llm,
        lambda r: [
            f"- 模型：{r['model']}，成功 {r['runs']} 次 / 失败 {r['errors']} 次",
            f"- TTFT：{_fmt_stats(r['ttft'], LLM_TTFT_BUDGET_MS)}",
            f"- 总耗时：{_fmt_stats(r['total'], LLM_TOTAL_BUDGET_MS)}",
            f"- 结论：{'PASS' if r['pass'] else 'FAIL'}",
            f"- 样本 TTFT：{r['ttft']['samples']}",
        ],
        "填 MAAS_API_KEY 后重跑",
    )

    section(
        "2. MaaS 视觉识别（Qwen-VL，连通性/延迟探测）",
        results.get("vision"),
        lambda r: [
            f"- 模型：{r['model']}，成功 {r['runs']} 次 / 失败 {r['errors']} 次",
            f"- TTFT：{_fmt_stats(r['ttft'], LLM_TTFT_BUDGET_MS)}",
            f"- 总耗时：{_fmt_stats(r['total'], VL_TOTAL_BUDGET_MS)}",
            f"- 结论：{'PASS' if r['pass'] else 'FAIL'}（注：1×1 测试图仅验证链路，真实拼图更慢）",
        ],
        "填 MAAS_API_KEY + MAAS_VL_MODEL 后加 --vision 重跑",
    )

    section(
        "3. SIS 语音合成（TTS）",
        results.get("tts"),
        lambda r: [
            f"- 音色：{r['voice']}，成功 {r['runs']} 次 / 失败 {r['errors']} 次，末次音频 {r['bytes']} 字节",
            f"- 整段返回：{_fmt_stats(r['ttfb'], TTS_BUDGET_MS)}",
            f"- 结论：{'PASS' if r['pass'] else 'FAIL'}（run_tts 为整段返回，流式首包会低于此值）",
        ],
        "填 HW_AK/HW_SK/HW_PROJECT_ID 后加 --tts 重跑",
    )

    section(
        "4. SIS 一句话识别（ASR）",
        results.get("asr"),
        lambda r: [
            f"- 属性：{r['property']}，成功 {r['runs']} 次 / 失败 {r['errors']} 次",
            f"- 识别耗时：{_fmt_stats(r['total'], ASR_BUDGET_MS)}",
            f"- 结论：{'PASS' if r['pass'] else 'FAIL'}（1.5s 静音样本，仅测链路延迟）",
        ],
        "填 HW_AK/HW_SK/HW_PROJECT_ID 后加 --asr 重跑",
    )

    lines += [
        "## 5. 怎么用这份报告",
        "",
        "1. 把真实 P95 填回 docs/智能体体系与实时翻译架构.md §13 与 realtime/bench.py 的假设常量；",
        "2. 若 LLM TTFT > 350ms：把 Orchestrator(cot_deadline_ms) 调到 600–900ms，并确认 L4 仍 ≤ 600ms；",
        "3. 若 VL 总耗时 P95 > 3000ms：识别延迟过高，建议启用端侧 DTW 双引擎（research/fastpath-frontend）；",
        "4. 若 TTS 整段 > 300ms：词级音频预热从优化项升级为上线必做项（见架构文档 §4.4）。",
        "",
    ]
    REPORT.write_text("\n".join(lines), encoding="utf-8")


async def main_async(args: argparse.Namespace) -> int:
    load_env()
    results: dict[str, dict | None] = {}
    results["llm"] = await probe_llm(args.runs)
    results["vision"] = await probe_vision(args.runs) if (args.vision or args.all) else None
    results["tts"] = probe_tts(args.runs) if (args.tts or args.all) else None
    results["asr"] = probe_asr(args.runs) if (args.asr or args.all) else None
    write_report(results, args.runs)

    def _line(name: str, result: dict | None, key: str, sub: str) -> str:
        if not result:
            return f"{name}: 未启用"
        if result.get("ok"):
            stats = result.get(key) or {}
            return f"{name}: P95 {sub} {stats.get('p95', 0):.0f}ms -> {'PASS' if result['pass'] else 'FAIL'}"
        return f"{name}: 未执行 - {result.get('reason')}"

    print(_line("LLM   ", results["llm"], "ttft", "TTFT"))
    print(_line("VL    ", results["vision"], "total", "总耗时"))
    print(_line("TTS   ", results["tts"], "ttfb", "整段"))
    print(_line("ASR   ", results["asr"], "total", "耗时"))
    print("报告已写入：" + str(REPORT))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=int, default=5, help="每个探测的试次（默认 5）")
    parser.add_argument("--vision", action="store_true", help="加测 MaaS 视觉模型（Qwen-VL）")
    parser.add_argument("--tts", action="store_true", help="加测 SIS 语音合成")
    parser.add_argument("--asr", action="store_true", help="加测 SIS 一句话识别")
    parser.add_argument("--all", action="store_true", help="全部探测")
    args = parser.parse_args()
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
