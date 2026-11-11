import copy
import json
import unittest
from unittest.mock import patch

from client import complete, sse_data
from common import load_config, load_tasks, performance, prompt_for, summarize


class FakeResponse:
    def __init__(self, chunks):
        self.lines = []
        for chunk in chunks:
            self.lines.extend([("data: " + json.dumps(chunk) + "\n").encode(), b"\n"])
        self.lines.extend([b"data: [DONE]\n", b"\n"])

    def __enter__(self):
        return iter(self.lines)

    def __exit__(self, *_):
        pass


class PipelineTests(unittest.TestCase):
    def test_frozen_datasets_and_untouched_ifeval_prompts(self):
        config = load_config()
        tasks = load_tasks(config)
        self.assertEqual([len(tasks[k]) for k in tasks], [164, 378, 541])
        task = tasks["ifeval"][0][1]
        self.assertEqual(prompt_for("ifeval", task), task["prompt"])
        code_prompt = prompt_for("humaneval_plus", tasks["humaneval_plus"][0][1])
        self.assertTrue(code_prompt.startswith("Please provide a self-contained Python script"))
        self.assertNotIn(tasks["humaneval_plus"][0][1]["canonical_solution"], code_prompt)

    def test_sse_comments_utf8_multiline_and_done(self):
        lines = [b": keepalive\r\n", b"\r\n", b'data: {"text":\r\n',
                 'data: "\u4e2d\u6587"}\r\n'.encode(), b"\r\n", b"data: [DONE]\n", b"\n"]
        result = list(sse_data(lines))
        self.assertEqual(json.loads(result[0]), {"text": "\u4e2d\u6587"})
        self.assertEqual(result[1], "[DONE]")

    def response_fixture(self):
        return [
            {"id": "chatcmpl-test", "choices": [{"delta": {"role": "assistant", "content": ""}}]},
            {"choices": [{"delta": {"reasoning_content": "think"}}]},
            {"choices": [{"delta": {"content": "answer"}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}],
             "usage": {"prompt_tokens": 100, "completion_tokens": 20,
                       "prompt_tokens_details": {"cached_tokens": 25}},
             "timings": {"predicted_per_second": 10, "predicted_ms": 2000}},
        ]

    def test_native_stream_separates_reasoning_and_does_not_misjoin_concurrent_requests(self):
        chunks = self.response_fixture()
        before = {"requests": [], "totals": {"requests": 5}}
        after = {"requests": [{"id": "native", "prompt_tokens": 100, "output_tokens": 20}],
                 "totals": {"requests": 6}}
        with patch("client.json_get", side_effect=[before, after]), \
                patch("client.urllib.request.build_opener") as factory:
            factory.return_value.open.return_value = FakeResponse(chunks)
            result = complete(load_config(), "test")
        self.assertEqual(result["answer"], "answer")
        self.assertEqual(result["reasoning"], "think")
        self.assertIsNotNone(result["ttft_s"])
        self.assertEqual(result["native_request"]["id"], "native")
        after["totals"]["requests"] = 7
        with patch("client.json_get", side_effect=[before, after]), \
                patch("client.urllib.request.build_opener") as factory:
            factory.return_value.open.return_value = FakeResponse(chunks)
            result = complete(load_config(), "test")
        self.assertIsNone(result["native_request"])

    def test_incomplete_stream_is_not_a_scored_model_failure(self):
        chunks = self.response_fixture()[:-1]
        with patch("client.json_get", return_value={"requests": [], "totals": {"requests": 0}}), \
                patch("client.urllib.request.build_opener") as factory:
            factory.return_value.open.return_value = FakeResponse(chunks)
            with self.assertRaisesRegex(RuntimeError, "Incomplete stream"):
                complete(load_config(), "test")

    def test_token_weighted_cache_and_time_weighted_decode_speed(self):
        responses = [
            {"usage": {"prompt_tokens": 100, "prompt_tokens_details": {"cached_tokens": 50}},
             "timings": {"predicted_ms": 1000, "predicted_per_second": 10}},
            {"usage": {"prompt_tokens": 900, "prompt_tokens_details": {"cached_tokens": 0}},
             "timings": {"predicted_ms": 3000, "predicted_per_second": 30}},
        ]
        result = performance(responses)
        self.assertAlmostEqual(result["kv_cache_hit_ratio"], 0.05)
        self.assertEqual(result["decode_tok_s"], 25)
        responses[0]["usage"].pop("prompt_tokens_details")
        self.assertIsNone(performance(responses)["kv_cache_hit_ratio"])

    def test_plus_requires_base_and_plus_and_partial_is_explicit(self):
        rows = [
            {"benchmark": "humaneval_plus", "finish_reason": "stop",
             "score": {"base_status": "fail", "plus_status": "pass"}},
            {"benchmark": "humaneval_plus", "finish_reason": "length",
             "score": {"base_status": "pass", "plus_status": "pass"}},
        ]
        summary = summarize(rows, {"humaneval_plus": 164, "mbpp_plus": 378, "ifeval": 541})
        self.assertEqual(summary["humaneval_plus"]["plus_pass_at_1"], 0.5)
        self.assertFalse(summary["humaneval_plus"]["complete"])
        self.assertEqual(summary["humaneval_plus"]["truncated"], 1)

    def test_ifeval_instruction_score_uses_instruction_denominator(self):
        rows = [
            {"benchmark": "ifeval", "finish_reason": "stop", "score": {
                "strict_prompt": False, "strict_instructions": [True, False],
                "loose_prompt": True, "loose_instructions": [True, True]}},
            {"benchmark": "ifeval", "finish_reason": "stop", "score": {
                "strict_prompt": True, "strict_instructions": [True],
                "loose_prompt": True, "loose_instructions": [True]}},
        ]
        result = summarize(rows, {"humaneval_plus": 164, "mbpp_plus": 378, "ifeval": 541})["ifeval"]
        self.assertEqual(result["strict_prompt"], 0.5)
        self.assertAlmostEqual(result["strict_instruction"], 2 / 3)
        self.assertEqual(result["loose_instruction"], 1)


if __name__ == "__main__":
    unittest.main()
