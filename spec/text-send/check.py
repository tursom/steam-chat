#!/usr/bin/env python3
"""Run bounded TLC checks; expected counterexamples are successful checks."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar', default=os.environ.get('TLA2TOOLS_JAR'))
    parser.add_argument('--output', type=Path, help='new, external evidence directory')
    parser.add_argument('--timeout', type=int, default=120, help='seconds per TLC check')
    args = parser.parse_args()
    if not args.jar or not Path(args.jar).is_file():
        parser.error('set TLA2TOOLS_JAR or --jar to a tla2tools.jar (TLC 2.19)')
    jar = Path(args.jar).resolve()
    if args.output:
        output = args.output.resolve()
        if output.is_relative_to(ROOT):
            parser.error('--output must be outside the repository (TLC state files can be large)')
        output.mkdir(parents=True, exist_ok=False)
    else:
        cache = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'steam-chat-tla'
        cache.mkdir(parents=True, exist_ok=True)
        output = Path(tempfile.mkdtemp(prefix='text-send-', dir=cache))
    print(f'Evidence: {output}', flush=True)
    report_inputs = ['spec/text-send/TextSend.tla', 'spec/text-send/TextSendEvidence.tla', 'spec/text-send/TextSendGuard.tla', 'spec/text-send/cases.json',
              'spec/text-send/check.py', 'spec/text-send/replay.test.cjs', 'spec/text-send/README.md',
              'web/app.ts', 'src/server/chat-service.ts',
              'docs/message-retry-design.md']
    # The guard replay loads the real service and transitive local TS modules.
    inputs = sorted(set(report_inputs + ['package.json', 'package-lock.json'] +
                        [str(path.relative_to(ROOT)) for path in (ROOT / 'src').rglob('*.ts')]))
    hashes = {name: digest(ROOT / name) for name in inputs}
    for name in inputs:
        target = output / 'input' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    cases = json.loads((HERE / 'cases.json').read_text())
    results = []
    for case in cases:
        folder = output / case['name']
        folder.mkdir()
        module = case.get('module', 'TextSend')
        constants = ([f'  GuardMismatch = {str(case["guardMismatch"]).upper()}',
                      f'  PreserveUncertainty = {str(case.get("preserveUncertainty", False)).upper()}',
                      f'  StatusOnlyFailure = {str(case.get("statusOnlyFailure", True)).upper()}']
                     if module == 'TextSendGuard' else [
                         f'  Scenario = "{case["scenario"]}"',
                         f'  AutoReplay = {str(case.get("autoReplay", False)).upper()}',
                         f'  MatchAll = {str(case.get("matchAll", False)).upper()}',
                         f'  EmptyMeansFailed = {str(case.get("emptyMeansFailed", False)).upper()}'])
        if module == 'TextSendEvidence':
            constants += [f'  SkipExistingEvidence = {str(case.get("skipExistingEvidence", False)).upper()}',
                          f'  KeepThirtySecondWindow = {str(case.get("keepThirtySecondWindow", False)).upper()}']
        config = '\n'.join([
            f'SPECIFICATION {case.get("spec", "Spec")}',
            'CHECK_DEADLOCK FALSE',
            'CONSTANTS',
            *constants,
            *[f'INVARIANT {name}' for name in case.get('invariants', [])],
            *([f'PROPERTY {case["property"]}'] if 'property' in case else []), ''])
        config_path = folder / f'{module}.cfg'
        config_path.write_text(config)
        shutil.copyfile(output / f'input/spec/text-send/{module}.tla', folder / f'{module}.tla')
        if module == 'TextSendEvidence':
            shutil.copyfile(output / 'input/spec/text-send/TextSend.tla', folder / 'TextSend.tla')
        command = ['java', '-XX:+UseParallelGC', '-Xmx512m', '-cp', str(jar), 'tlc2.TLC',
                   '-workers', '1', '-seed', '1', '-fp', '0', '-metadir', str(folder / 'states'),
                   '-config', f'{module}.cfg', f'{module}.tla']
        try:
            completed = subprocess.run(command, capture_output=True, text=True,
                                       timeout=args.timeout, cwd=folder)
            text = completed.stdout + completed.stderr
            code = completed.returncode
        except subprocess.TimeoutExpired as error:
            text = (error.stdout or b'').decode() + (error.stderr or b'').decode()
            code = -1
        (folder / 'tlc.txt').write_text(text)
        expected = case['expect']
        if expected == 'pass':
            matched = code == 0 and 'Model checking completed. No error has been found.' in text
        elif expected == 'temporal':
            matched = code == 13 and 'Temporal properties were violated.' in text and 'Back to state' in text
        else:
            matched = code == 12 and f'Invariant {expected} is violated.' in text
        stats = re.search(r'([\d,]+) states generated, ([\d,]+) distinct states found', text)
        states = stats.group(2) if stats else '?'
        depth = re.search(r'The depth of the complete state graph search is (\d+)', text)
        trace = re.findall(r'^State (\d+):', text, re.M)
        results.append({**case, 'exitCode': code, 'matched': matched,
                        'distinctStates': states,
                        'depth': depth.group(1) if depth else None,
                        'traceStates': len(trace),
                        'configSha256': digest(config_path),
                        'logSha256': digest(folder / 'tlc.txt')})
        print(f'{"OK" if matched else "FAIL"} {case["name"]}: '
              f'exit={code}, states={states}, trace states={len(trace)}', flush=True)
    replay = subprocess.run(['node', '--test', str(HERE / 'replay.test.cjs')],
                            cwd=ROOT, capture_output=True, text=True, timeout=60)
    (output / 'replay.txt').write_text(replay.stdout + replay.stderr)
    # The replay reads the real working tree; refuse results if inputs changed.
    unchanged = all(digest(ROOT / name) == value for name, value in hashes.items())
    success = all(item['matched'] for item in results) and replay.returncode == 0 and unchanged
    metadata = {
        'gitHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'jarSha256': digest(jar), 'inputs': hashes, 'inputsUnchanged': unchanged,
        'results': results, 'replayExitCode': replay.returncode, 'success': success,
        'nodeVersion': subprocess.check_output(['node', '--version'], text=True).strip(),
        'typescriptVersion': subprocess.check_output(
            ['node', '-p', 'require("typescript").version'], cwd=ROOT, text=True).strip(),
    }
    (output / 'manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
    lines = ['# 文字发送模型检查结果', '',
             '由 `python3 spec/text-send/check.py` 生成。预期反例与通过项必须全部匹配。', '',
             f'整体结果：**{"全部符合预期" if success else "存在未通过项"}**。', '',
             f'完整运行证据：`{output}`。', '',
             f'基准提交：`{metadata["gitHead"]}`；具体输入以以下 SHA-256 为准。', '',
             'TLC：单 worker、固定 seed=1、fp=0、Java 堆上限 512 MiB；状态规模有界。', '',
             f'Node.js `{metadata["nodeVersion"]}`；TypeScript `{metadata["typescriptVersion"]}`。', '',
             '| 检查 | 预期 | 退出码 | 不同状态数 | 轨迹状态数 | 符合预期 |',
             '| --- | --- | ---: | ---: | ---: | --- |']
    for item in results:
        lines.append(f'| {item["name"]} | {item["expect"]} | {item["exitCode"]} | '
                     f'{item["distinctStates"]} | {item["traceStates"]} | '
                     f'{"是" if item["matched"] else "否"} |')
    lines += ['', f'真实前端函数回放退出码：`{replay.returncode}`。', '', '输入指纹：', '',
              '| 文件 | SHA-256 |', '| --- | --- |']
    lines += [f'| `{name}` | `{hashes[name]}` |' for name in report_inputs]
    lines += [f'| `tla2tools.jar` | `{metadata["jarSha256"]}` |', '',
              f'另有源码及依赖声明，共 `{len(inputs)}` 个输入文件的快照和指纹保存在 `manifest.json`。', '',
              '源码或模型变化后，本表不再是新版本的验证证据。完整日志、配置、输入快照和 manifest 在证据目录中。', '']
    (HERE / 'RESULTS.md').write_text('\n'.join(lines))
    traces = HERE / 'traces'
    traces.mkdir(exist_ok=True)
    shutil.copyfile(output / 'replay.txt', traces / 'replay.txt')
    for item in results:
        if item['name'] in {'external-attribution', 'replacement-attribution',
                             'late-known-check', 'existing-known-check', 'known-result-liveness',
                             'guard-failure-soundness', 'guard-manual-retry-duplicate',
                             'mutation-evidence-skip-existing', 'mutation-evidence-thirty-seconds'}:
            text = (output / item['name'] / 'tlc.txt').read_text()
            (traces / f'{item["name"]}.txt').write_text(text)
    print(f'Replay exit={replay.returncode}; inputs unchanged={unchanged}; success={success}', flush=True)
    if replay.returncode:
        print(replay.stdout + replay.stderr)
    raise SystemExit(0 if success else 1)


if __name__ == '__main__':
    main()
