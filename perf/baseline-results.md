# Baseline Performance Numbers

Measured 2026-02-21 with mocked VNC/LLM (no real connections).

| Test Case | Metric | Baseline | Optimized | Improvement |
|-----------|--------|----------|-----------|-------------|
| Adaptive VNC Wait (50ms rect) | Capture latency | 805ms | 235ms | 70.8% |
| Adaptive VNC Wait (200ms rect) | Capture latency | 810ms | 300ms | 63.0% |
| Adaptive VNC Wait (500ms rect) | Capture latency | 804ms | 610ms | 24.1% |
| Screenshot Hash Cache Hit | LLM calls | 10 | 1 | 90.0% |
| Screenshot Hash Cache Miss | LLM calls | 10 | 10 | 0% (correct) |
| A11y Context Cache (<500ms) | Queries | 5 | 1 | 80.0% |
| A11y Context Cache (>500ms) | Queries | 5 | 5 | 0% (correct) |
| Parallel Fetch | Combined time | 243ms | 235ms | 3.1% |
| Async Debug Write | Blocking time | 0.31ms | 0.02ms | 94.1% |

## 20-Step Task Scenario (Static UI)

| Metric | Baseline | Optimized | Savings |
|--------|----------|-----------|---------|
| Screenshot waits | 16,000ms | 4,000ms | 75% |
| LLM API calls | 20 | 2 | 90% |
| A11y queries | 600ms | 120ms | 80% |
| **Total overhead** | **~26.6s** | **~8.1s** | **~70%** |
