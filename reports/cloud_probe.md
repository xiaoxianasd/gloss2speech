# 云端真实探测报告

> 生成时间：2026-11-26 00:55:26
> 机器：Windows-11-10.0.26300-SP0
> 试次：3

## 1. MaaS 结构化 CoT 造句（LLM）

- 模型：deepseek-v4.1-flash-1017，成功 3 次 / 失败 0 次
- TTFT：P50 **1230ms** / P95 **1406ms** / P99 1406ms（min 620 / max 1406，预算 ≤ 350ms）
- 总耗时：P50 **1945ms** / P95 **9217ms** / P99 9217ms（min 1367 / max 9217，预算 ≤ 900ms）
- 结论：FAIL
- 样本 TTFT：[620.1, 1405.8, 1229.5]

## 2. MaaS 视觉识别（Qwen-VL，连通性/延迟探测）

- 模型：deepseek-v4.1-flash-1017，成功 3 次 / 失败 0 次
- TTFT：P50 **2232ms** / P95 **4566ms** / P99 4566ms（min 1409 / max 4566，预算 ≤ 350ms）
- 总耗时：P50 **2934ms** / P95 **5016ms** / P99 5016ms（min 1845 / max 5016，预算 ≤ 3000ms）
- 结论：FAIL（注：1×1 测试图仅验证链路，真实拼图更慢）

## 3. SIS 语音合成（TTS）

- 音色：chinese_xiaoyan_common，成功 3 次 / 失败 0 次，末次音频 105232 字节
- 整段返回：P50 **308ms** / P95 **1026ms** / P99 1026ms（min 206 / max 1026，预算 ≤ 300ms）
- 结论：FAIL（run_tts 为整段返回，流式首包会低于此值）

## 4. SIS 一句话识别（ASR）

- 属性：chinese_16k_common，成功 3 次 / 失败 0 次
- 识别耗时：P50 **102ms** / P95 **816ms** / P99 816ms（min 101 / max 816，预算 ≤ 2000ms）
- 结论：PASS（1.5s 静音样本，仅测链路延迟）

## 5. 怎么用这份报告

1. 把真实 P95 填回 docs/智能体体系与实时翻译架构.md §13 与 realtime/bench.py 的假设常量；
2. 若 LLM TTFT > 350ms：把 Orchestrator(cot_deadline_ms) 调到 600–900ms，并确认 L4 仍 ≤ 600ms；
3. 若 VL 总耗时 P95 > 3000ms：识别延迟过高，建议启用端侧 DTW 双引擎（research/fastpath-frontend）；
4. 若 TTS 整段 > 300ms：词级音频预热从优化项升级为上线必做项（见架构文档 §4.4）。
