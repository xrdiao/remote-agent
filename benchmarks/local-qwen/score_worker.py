import dataclasses
import json
import os
import random
import socket
import sys
from pathlib import Path


def probe():
    assert not Path("/home/rong/.config").exists()
    denied = False
    try:
        socket.create_connection(("1.1.1.1", 80), timeout=1)
    except OSError:
        denied = True
    assert denied
    try:
        Path("/code/SHOULD_NOT_EXIST").write_text("unsafe")
    except OSError:
        pass
    else:
        raise AssertionError("Code mount is writable")
    return {"isolated_home": True, "network_denied": True, "read_only_code": True}


def score(payload):
    benchmark, task, answer = payload["benchmark"], payload["task"], payload["answer"]
    config = payload["config"]
    random.seed(config["ifeval_langdetect_seed"])
    if benchmark == "ifeval":
        from langdetect import DetectorFactory
        from instruction_following_eval import evaluation_lib

        DetectorFactory.seed = config["ifeval_langdetect_seed"]
        example = evaluation_lib.InputExample(**task)
        responses = {task["prompt"]: answer}
        strict = evaluation_lib.test_instruction_following_strict(example, responses)
        loose = evaluation_lib.test_instruction_following_loose(example, responses)
        return {
            "strict_prompt": strict.follow_all_instructions,
            "strict_instructions": strict.follow_instruction_list,
            "loose_prompt": loose.follow_all_instructions,
            "loose_instructions": loose.follow_instruction_list,
            "instruction_ids": strict.instruction_id_list,
        }

    from evalplus.data.mbpp import mbpp_deserialize_inputs
    from evalplus.eval import untrusted_check
    from evalplus.eval._special_oracle import MBPP_OUTPUT_NOT_NONE_TASKS
    from evalplus.gen.util import trusted_exec
    from evalplus.sanitize import sanitize

    dataset = "humaneval" if benchmark == "humaneval_plus" else "mbpp"
    if dataset == "mbpp":
        for prefix in ("base", "plus"):
            task[prefix + "_input"] = mbpp_deserialize_inputs(task["task_id"], task[prefix + "_input"])
    solution = sanitize(answer, entrypoint=task["entry_point"])
    result = {"sanitized_solution": solution}
    for prefix in ("base", "plus"):
        inputs = task[prefix + "_input"]
        expected, reference_times = trusted_exec(
            task["prompt"] + task["canonical_solution"], inputs, task["entry_point"],
            record_time=True,
            output_not_none=dataset == "mbpp" and task["entry_point"] in MBPP_OUTPUT_NOT_NONE_TASKS,
        )
        status, details = untrusted_check(
            dataset, solution, inputs, task["entry_point"],
            expected=expected, atol=task["atol"], ref_time=reference_times,
            fast_check=config["evalplus_fast_check"],
            min_time_limit=config["evalplus_min_time_limit"],
            gt_time_limit_factor=config["evalplus_gt_time_limit_factor"],
        )
        result[prefix + "_status"] = status
        result[prefix + "_tested"] = len(details)
        result[prefix + "_total"] = len(inputs)
    return result


if __name__ == "__main__":
    result = probe() if sys.argv[1] == "--probe" else score(json.loads(Path(sys.argv[1]).read_text()))
    print(json.dumps({"result": result}, ensure_ascii=True))
