# Local Qwen evaluation

This suite measures the running Strata Gyro-S deployment, not OpenCode's agent
tools. It does not change RA, OpenCode configuration, or the active 108K profile.

## Frozen protocol

- HumanEval+ v0.1.10: 164 examples; MBPP+ v0.2.0: 378 examples.
- IFEval: 541 examples from google-research commit
  `e6890f85757dd84e27ca6df2dd30651dafad28e0`.
- One completion per task, greedy temperature 0, top-p 1, seed 0.
- Explicit thinking enabled, reasoning effort `high`, which the installed Qwen
  template maps to `xhigh`. Budget: 32768 tokens including thinking and answer.
- Coding prompts and sanitization follow EvalPlus 0.3.1's default chat protocol.
  Only final answer text is sanitized; reasoning is never sent to the grader.
  IFEval receives the original prompt and scores unmodified final answer text.
- Unmodified official EvalPlus `trusted_exec`, `untrusted_check`, special oracles,
  deserialization, and sanitizer; official IFEval strict/loose checkers.
- Coding Plus pass@1 requires both base and Plus tests to pass. With one sample,
  pass@1 is the fraction of tasks passing. IFEval reports both prompt-level and
  instruction-level metrics, with the latter weighted by instruction counts.
- EvalPlus limits: 1 second minimum per test, 4x reference time, default official
  task timeout, fast checking. Memory is explicitly capped at 2 GiB instead of
  the upstream default 4 GiB for this workstation. Language detection seed is 0.
  These are local results under this recorded protocol, not an official rank.

Official sources/data and the isolated Python environment are under
`_shots/local-qwen-eval/`. Dataset SHA256s and upstream versions are in
`config.json`; source hashes and environment identity are captured per run.
The full official EvalPlus wheel is vendored without modifications. Only its
grading dependencies are installed, not unused model-provider frameworks.

## Commands

From the repository root:

```bash
PY=_shots/local-qwen-eval/venv/bin/python
"$PY" -m unittest discover -s benchmarks/local-qwen -p 'test_*.py'
"$PY" benchmarks/local-qwen/self_check.py
"$PY" benchmarks/local-qwen/run.py --smoke
"$PY" benchmarks/local-qwen/run.py
```

The smoke run uses two examples per dataset. Its results are pipeline validation,
not full benchmark scores. Do not start a full run until smoke output, thinking,
official checker results, and sandbox behavior have been reviewed.

Open a second terminal for live progress:

```bash
python3 benchmarks/local-qwen/monitor.py
```

The monitor follows `_shots/local-qwen-eval/latest-run.txt`. Use `--run-dir PATH`
to pin a run, or `--once` for one snapshot. Ctrl-C stops the monitor only.

To continue an interrupted run without regenerating completed outputs:

```bash
"$PY" benchmarks/local-qwen/run.py --run-dir PATH --resume
```

Use `--smoke` as well when resuming a smoke run. Resume requires identical
configuration, sources, and datasets. Already scored failures are not retried.
Infrastructure errors stop the run and are not silently counted as model errors.
Budget truncation is recorded and the resulting answer is graded normally.

## Isolation and measurements

Generated code runs only in a network-isolated bubblewrap namespace inside an
ephemeral user systemd cgroup: 2 GiB aggregate memory, no swap, 64 tasks. It sees
only read-only runtime/scorer mounts and private temporary storage, not your home
directory. One grading worker runs at a time. No elevated privileges or boot
autostart configuration are used.

The monitor distinguishes:

- Native decode throughput, including reasoning, from prefill throughput.
- Client TTFT (first nonempty reasoning/answer delta) from total request time.
- KV prompt-cache reuse from expert-cache hit rate and DFlash2 acceptance.
- Benchmark-only completed-request totals from server-global live telemetry.
- Whole-machine memory/swap and GPU readings from benchmark results.

Missing measurements display N/A. Partial scores are explicitly labeled partial.
Other clients can affect server-global telemetry and queue time. Avoid using
OpenCode/RA for generation during the run if you want clean performance data.
Per-request expert telemetry is associated only when exactly one native request
completed between snapshots and its usage matches; ambiguous records are not
assigned to benchmark tasks.

Each run retains raw final answers and reasoning, request parameters, timings,
usage, native telemetry, official scoring statuses, events, and progress
checkpoints. Files may contain task text and generated code; keep them local.
