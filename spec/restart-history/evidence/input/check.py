#!/usr/bin/env python3
"""Run TLC, require exact expected properties, preserve reproducible evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SAFETY = ["TypeOK", "CompleteOnlyArchived", "AccountIsolation", "NoFalseMerge",
          "UniqueDurableIdentity", "NoStaleCallbacks", "NoStaleQueries"]
INPUTS = ["RestartHistory.tla", "cases.json", "check.py", "README.md", "COUNTEREXAMPLES.md"]
SOURCE_INPUTS = ["src/steam/history-recovery.ts", "src/steam/message-logger.ts",
                 "src/steam/friend-message-events.ts", "test/restart-history-recovery.test.ts",
                 "test/message-logger.test.ts", "test/history-integration.test.ts",
                 "test/history-idempotency.test.ts"]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def config_for(case):
    constants = {"Mode": json.dumps(case.get("mode", "fixed")),
                 "ContactCount": case.get("contacts", 1),
                 "MessageCount": case.get("messages", 3),
                 "PageSize": case.get("pageSize", 1),
                 "FaultBudget": case.get("faults", 0),
                 "CrashBudget": case.get("crashes", 0),
                 "SwitchBudget": case.get("switches", 0),
                 "Inbound": str(case.get("inbound", False)).upper()}
    invariants = list(case.get("invariants", SAFETY))
    expected = case["expect"]
    if expected != "pass" and expected != case.get("property") and expected not in invariants:
        invariants.append(expected)
    return "\n".join([
        f'SPECIFICATION {"FairSpec" if "property" in case else "Spec"}',
        "CHECK_DEADLOCK FALSE", "CONSTANTS",
        *[f"  {key} = {value}" for key, value in constants.items()],
        *[f"INVARIANT {name}" for name in invariants],
        *([f'PROPERTY {case["property"]}'] if "property" in case else []), ""])


def expected_result(case, code, log, config):
    expected = case["expect"]
    trace = bool(re.search(r"^State \d+:", log, re.M))
    if expected == "pass":
        return code == 0 and "Model checking completed. No error has been found." in log
    if expected == case.get("property"):
        # TLC 2.19 does not name a violated temporal property in its message.
        # Require ONE configured property, and require that exact name, exit 13,
        # a real counterexample and a lasso/stuttering end. No generic 'temporal'.
        properties = re.findall(r"^PROPERTY\s+(\w+)\s*$", config, re.M)
        return (properties == [expected] and code == 13 and trace
                and "Temporal properties were violated." in log
                and bool(re.search(r"Back to state|Stuttering", log)))
    return (expected in re.findall(r"^INVARIANT\s+(\w+)\s*$", config, re.M)
            and code == 12 and trace and f"Invariant {expected} is violated." in log)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", default=os.environ.get("TLA2TOOLS_JAR"))
    parser.add_argument("--timeout", type=int, default=120, help="seconds per case")
    parser.add_argument("--implementation", action="store_true", help="also build and run restart integration regressions")
    args = parser.parse_args()
    if not args.jar or not Path(args.jar).is_file():
        parser.error("provide --jar or TLA2TOOLS_JAR pointing to tla2tools.jar")
    jar = Path(args.jar).resolve()
    output = HERE / "evidence"
    output.mkdir(exist_ok=True)
    snapshots = output / "input"
    snapshots.mkdir(exist_ok=True)
    hashes = {name: sha(HERE / name) for name in INPUTS}
    source_hashes = {name: sha(ROOT / name) for name in SOURCE_INPUTS}
    for name in INPUTS:
        shutil.copyfile(HERE / name, snapshots / name)
    cases = json.loads((snapshots / "cases.json").read_text())
    results = []
    print(f"Evidence: {output}", flush=True)
    for case in cases:
        folder = output / case["name"]
        folder.mkdir(exist_ok=True)
        config = config_for(case)
        (folder / "RestartHistory.cfg").write_text(config)
        shutil.copyfile(snapshots / "RestartHistory.tla", folder / "RestartHistory.tla")
        started = time.monotonic()
        # TLC spill files are temporary; all retained files stay in this new spec directory.
        with tempfile.TemporaryDirectory(prefix=".tlc-", dir=HERE) as temporary:
            command = ["java", "-XX:+UseParallelGC", "-Xmx512m", "-cp", str(jar),
                       "tlc2.TLC", "-workers", "1", "-seed", "1", "-fp", "0",
                       "-metadir", temporary, "-config", "RestartHistory.cfg", "RestartHistory.tla"]
            try:
                process = subprocess.run(command, cwd=folder, text=True, capture_output=True,
                                         timeout=args.timeout)
                code, log = process.returncode, process.stdout + process.stderr
            except subprocess.TimeoutExpired as error:
                code = -1
                log = (error.stdout or b"").decode() + (error.stderr or b"").decode()
        (folder / "tlc.txt").write_text(log)
        (folder / "command.json").write_text(json.dumps(command, indent=2) + "\n")
        # Generated trace-explorer modules are unnecessary; the unedited TLC log
        # contains the full trace and each case retains its model and config.
        for generated in folder.glob("RestartHistory_TTrace_*"):
            if generated.is_file():
                generated.unlink()
        matched = expected_result(case, code, log, config)
        stats = re.search(r"([\d,]+) states generated, ([\d,]+) distinct states found", log)
        result = {**case, "exitCode": code, "matched": matched,
                  "generatedStates": stats.group(1) if stats else None,
                  "distinctStates": stats.group(2) if stats else None,
                  "traceStates": len(re.findall(r"^State \d+:", log, re.M)),
                  "seconds": round(time.monotonic() - started, 2),
                  "configSha256": sha(folder / "RestartHistory.cfg"),
                  "logSha256": sha(folder / "tlc.txt")}
        results.append(result)
        print(f'{"OK" if matched else "FAIL"} {case["name"]}: '
              f'exit={code}, states={result["distinctStates"]}, '
              f'trace={result["traceStates"]}, {result["seconds"]}s', flush=True)
    implementation = None
    if args.implementation:
        environment = {**os.environ, "STEAM_CHAT_DISABLE_AUTOSTART": "1"}
        build = subprocess.run(["npm", "run", "build"], cwd=ROOT, env=environment,
                               capture_output=True, text=True, timeout=args.timeout)
        (output / "build.txt").write_text(build.stdout + build.stderr)
        tests = None
        if build.returncode == 0:
            tests = subprocess.run(["node", "--test", "dist/test/restart-history-recovery.test.js",
                                    "dist/test/message-logger.test.js", "dist/test/history-integration.test.js",
                                    "dist/test/history-idempotency.test.js"], cwd=ROOT, env=environment,
                                   capture_output=True, text=True, timeout=args.timeout)
            (output / "implementation.txt").write_text(tests.stdout + tests.stderr)
        implementation = {"buildExitCode": build.returncode,
                          "testExitCode": tests.returncode if tests else None}
        print(f"Implementation: {implementation}", flush=True)
    unchanged = (all(sha(HERE / name) == digest for name, digest in hashes.items())
                 and all(sha(ROOT / name) == digest for name, digest in source_hashes.items()))
    success = (unchanged and all(result["matched"] for result in results)
               and (implementation is None or implementation == {"buildExitCode": 0, "testExitCode": 0}))
    versions = sorted({match.group(0) for case in cases for match in
                       re.finditer(r"^TLC2 Version .+$", (output / case["name"] / "tlc.txt").read_text(), re.M)})
    manifest = {"success": success, "inputsUnchanged": unchanged, "inputs": hashes,
                "sourceInputs": source_hashes, "implementation": implementation,
                "jarSha256": sha(jar), "tlcVersions": versions,
                "javaVersion": subprocess.run(["java", "-version"], capture_output=True, text=True).stderr.strip(),
                "results": results}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    lines = ["# 重启历史恢复：TLC 实测结果", "",
             f'整体结果：**{"全部符合预期" if success else "存在未通过项"}**。', "",
             "由 `check.py` 实际调用 Java/TLC 生成。模型结果仅适用于有界抽象，生产实现另用集成回归验证。", "",
             f'TLC：`{"; ".join(versions)}`；单 worker、seed=1、fp=0、512 MiB 堆。', "",
             "每项保留模型、配置、完整日志和命令；输入快照及 SHA-256 见 [manifest](evidence/manifest.json)。", "",
             "活性反例的性质名由配置中唯一的 PROPERTY 精确核对（TLC 的活性错误正文不输出名字）；",
             "另须退出码 13、完整轨迹及循环/停滞结尾。安全反例须退出码 12 且日志中的性质名精确匹配。", "",
             "| 检查 | 预期 | 退出码 | 不同状态 | 轨迹状态 | 符合 |",
             "| --- | --- | ---: | ---: | ---: | --- |"]
    for result in results:
        name = result["name"]
        lines.append(f'| [{name}](evidence/{name}/tlc.txt) | {result["expect"]} | '
                     f'{result["exitCode"]} | {result["distinctStates"]} | '
                     f'{result["traceStates"]} | {"是" if result["matched"] else "否"} |')
    lines += ["", f"实现回归：`{implementation}`（None 表示本次未运行）。",
              "日志见 `evidence/build.txt` 和 `evidence/implementation.txt`；使用本地 SDK 替身与真实归档存储，不连接 Steam。"]
    lines += ["", "输入指纹：", "", "| 输入 | SHA-256 |", "| --- | --- |"]
    lines += [f"| `{name}` | `{digest}` |" for name, digest in hashes.items()]
    lines += [f"| `{name}` | `{digest}` |" for name, digest in source_hashes.items()]
    lines += [f'| `tla2tools.jar` | `{manifest["jarSha256"]}` |', "",
              f'输入运行期间未变化：`{unchanged}`。模型或配置变化后须重跑。', ""]
    (HERE / "RESULTS.md").write_text("\n".join(lines))
    raise SystemExit(0 if success else 1)


if __name__ == "__main__":
    main()
