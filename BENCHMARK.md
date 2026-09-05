# BENCHMARK

Generated 2026-09-05T12:54:47.855Z on win32 x64, 16 CPUs (Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz), Node v24.14.1, 16089.6 MB RAM.

All tasks are deterministic-planner tasks (1 filesystem write + acceptance check + full plan/execute/verify/review lifecycle, ~20 events each). No LLM calls.

| Benchmark | Result |
|---|---|
| Startup (sqlite) | cold 150 ms, warm 4 ms |
| 300 tasks, memory, concurrency 16 | 8973 ms → 33.4 tasks/s, 300/300 completed, 9000 events, heap Δ 27.2 MB, RSS 138.8 MB |
| 300 tasks, sqlite, concurrency 16 | 11445 ms → 26.2 tasks/s, 300/300 completed, 9000 events, heap Δ -13.7 MB, RSS 156.1 MB |
| 300 tasks, sqlite, concurrency 4 | 12038 ms → 24.9 tasks/s, 300/300 completed, 9000 events, heap Δ -0.8 MB, RSS 158.3 MB |
| 300 tasks, file, concurrency 16 | 28446 ms → 10.5 tasks/s, 300/300 completed, 9000 events, heap Δ 9.8 MB, RSS 198.5 MB |
| Events, memory | sequential 423420 ev/s, concurrent 362888 ev/s, replay 20000 in 5 ms (4427129 ev/s) |
| Events, sqlite | sequential 7874 ev/s, concurrent 6135 ev/s, replay 20000 in 79 ms (253548 ev/s) |
| Events, file/jsonl | sequential 3830 ev/s, concurrent 3865 ev/s, replay 20000 in 2 ms (9882399 ev/s) |
| Tool calls | 200 concurrent filesystem.write in 981 ms (204/s); 100 concurrent terminal.execute in 638 ms (157/s) |
| Recovery | restart+load 7 ms, checkpoint verify+resume 23 ms (phase EXECUTING, 1 steps kept) |

Notes: numbers are wall-clock from a single run inside the development sandbox and vary with disk/CPU. Re-run with `npm run bench` (env BENCH_TASKS to change task count).
