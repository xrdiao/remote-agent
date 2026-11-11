from pathlib import Path

from common import load_config, load_tasks, write_json
from sandbox import execute, score_one


def main():
    config = load_config()
    root = Path(config["artifact_root"]) / "self-check"
    tasks = load_tasks(config)
    results = {"sandbox": execute(config, root / "probe")}
    for name in ("humaneval_plus", "mbpp_plus"):
        task_id, task = tasks[name][0]
        correct = score_one(config, root, name, task_id + "_canonical", task,
                            task["prompt"] + task["canonical_solution"])
        wrong = score_one(config, root, name, task_id + "_wrong", task, "def unrelated():\n    return None\n")
        assert correct["base_status"] == correct["plus_status"] == "pass", correct
        assert wrong["base_status"] != "pass" and wrong["plus_status"] != "pass", wrong
        results[name] = {"canonical": correct, "wrong": wrong}
    fixture = {
        "key": -1, "prompt": "Include orbit.",
        "instruction_id_list": ["keywords:existence"],
        "kwargs": [{"keywords": ["orbit"]}],
    }
    positive = score_one(config, root, "ifeval", "positive", fixture, "orbit")
    negative = score_one(config, root, "ifeval", "negative", fixture, "stone")
    assert positive["strict_prompt"] and positive["loose_prompt"], positive
    assert not negative["strict_prompt"] and not negative["loose_prompt"], negative
    results["ifeval"] = {"positive": positive, "negative": negative}
    write_json(root / "result.json", {"ok": True, **results})
    print(root / "result.json")


if __name__ == "__main__":
    main()
