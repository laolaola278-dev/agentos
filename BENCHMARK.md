# BENCHMARK

Generated 2026-09-03T16:07:59.821Z on linux x64, 4 CPUs (Intel(R) Xeon(R) Processor @ 2.60GHz), Node v22.22.1, 3939.7 MB RAM.

All tasks are deterministic-planner tasks (1 filesystem write + acceptance check + full plan/execute/verify/review lifecycle, ~20 events each). No LLM calls.

| Benchmark | Result |
|---|---|
| Startup (sqlite) | cold 7 ms, warm 1 ms |
| 300 tasks, memory, concurrency 16 | 2266 ms → 132.4 tasks/s, 300/300 completed, 8700 events, heap Δ 12.2 MB, RSS 130.1 MB |
| 300 tasks, sqlite, concurrency 16 | 3312 ms → 90.6 tasks/s, 300/300 completed, 8700 events, heap Δ -9.3 MB, RSS 144.1 MB |
| 300 tasks, sqlite, concurrency 4 | 3045 ms → 98.5 tasks/s, 300/300 completed, 8700 events, heap Δ 5.1 MB, RSS 135.3 MB |
| 300 tasks, file, concurrency 16 | 7957 ms → 37.7 tasks/s, 300/300 completed, 8700 events, heap Δ 6.0 MB, RSS 135.9 MB |
| Events, memory | sequential 336983 ev/s, concurrent 314763 ev/s, replay 20000 in 4 ms (5129582 ev/s) |
| Events, sqlite | sequential 16855 ev/s, concurrent 17384 ev/s, replay 20000 in 118 ms (169570 ev/s) |
| Events, file/jsonl | sequential 3559 ev/s, concurrent 4068 ev/s, replay 20000 in 5 ms (4407989 ev/s) |
| Tool calls | 200 concurrent filesystem.write in 78 ms (2579/s); 100 concurrent terminal.execute in 235 ms (426/s) |
| Recovery | restart+load 1 ms, checkpoint verify+resume 7 ms (phase EXECUTING, 1 steps kept) |

Notes: numbers are wall-clock from a single run inside the development sandbox and vary with disk/CPU. Re-run with `npm run bench` (env BENCH_TASKS to change task count).
