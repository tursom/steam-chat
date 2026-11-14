#!/usr/bin/env python3
"""Check legacy counterexamples, the ordered-image model, and implementation replays."""
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


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar', default=os.environ.get('TLA2TOOLS_JAR'))
    parser.add_argument('--timeout', type=int, default=90, help='seconds per case')
    args = parser.parse_args()
    if not args.jar or not Path(args.jar).is_file():
        parser.error('provide --jar or TLA2TOOLS_JAR pointing to TLC 2.19 tla2tools.jar')
    jar = Path(args.jar).resolve()
    cache = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'steam-chat-tla'
    cache.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix='image-batch-', dir=cache))
    print(f'Evidence: {output}', flush=True)
    inputs = ['spec/image-batch-order/' + name for name in
              ['ImageBatch.tla', 'cases.json', 'check.py', 'replay.test.cjs', 'README.md']]
    inputs += ['web/app.ts', 'src/server/send-operations.ts', 'src/server/image-upload.ts',
               'src/server/chat-service.ts', 'test/send-operations.test.ts',
               'test/send-operations-api.test.ts', 'test/web-image-paste.test.ts',
               'test/browser/image-batch-order.cjs', 'docs/message-retry-design.md',
               'package.json', 'package-lock.json']
    hashes = {name: sha(ROOT / name) for name in inputs}
    for name in inputs:
        target = output / 'input' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    results = []
    tlc_versions = set()
    cases = json.loads((HERE / 'cases.json').read_text())
    for case in cases:
        folder = output / case['name']
        folder.mkdir()
        shutil.copyfile(output / 'input/spec/image-batch-order/ImageBatch.tla', folder / 'ImageBatch.tla')
        constants = {'ImageCount': str(case.get('images', 2)),
                     'OrderedBatch': str(case.get('ordered', False)).upper(),
                     'SerialRead': str(case.get('serialRead', False)).upper(),
                     'PreparedInOrder': str(case.get('preparedInOrder', False)).upper(),
                     'Healthy': str(case.get('healthy', False)).upper(),
                     'AllowRestart': str(case.get('restart', False)).upper(),
                     'ReleaseUnknown': str(case.get('releaseUnknown', False)).upper(),
                     'ReplayUnknown': str(case.get('replayUnknown', False)).upper(),
                     'CancelCommitAsUnsent': str(case.get('cancelCommitAsUnsent', False)).upper(),
                     'SkipCancelDrain': str(case.get('skipCancelDrain', False)).upper(),
                     'SkipMissing': str(case.get('skipMissing', False)).upper(),
                     'RetainDependencies': str(case.get('retainDependencies', True)).upper()}
        config = '\n'.join([f'SPECIFICATION {case.get("spec", "Spec")}',
                            'CHECK_DEADLOCK FALSE', 'CONSTANTS',
                            *[f'  {key} = {value}' for key, value in constants.items()],
                            *[f'INVARIANT {name}' for name in case.get('invariants', [])],
                            *([f'PROPERTY {case["property"]}'] if 'property' in case else []), ''])
        (folder / 'ImageBatch.cfg').write_text(config)
        command = ['java', '-XX:+UseParallelGC', '-Xmx512m', '-cp', str(jar), 'tlc2.TLC',
                   '-workers', '1', '-seed', '1', '-fp', '0', '-metadir', str(folder / 'states'),
                   '-config', 'ImageBatch.cfg', 'ImageBatch.tla']
        try:
            process = subprocess.run(command, capture_output=True, text=True, cwd=folder, timeout=args.timeout)
            code, log = process.returncode, process.stdout + process.stderr
        except subprocess.TimeoutExpired as error:
            code = -1
            log = (error.stdout or b'').decode() + (error.stderr or b'').decode()
        (folder / 'tlc.txt').write_text(log)
        version = re.search(r'^TLC2 Version (.+)$', log, re.M)
        if version:
            tlc_versions.add(version.group(1))
        expected = case['expect']
        matched = (code == 0 and 'Model checking completed. No error has been found.' in log
                   if expected == 'pass' else
                   code == 12 and f'Invariant {expected} is violated.' in log)
        states = re.search(r'[\d,]+ states generated, ([\d,]+) distinct states found', log)
        trace = len(re.findall(r'^State \d+:', log, re.M))
        results.append({**case, 'exitCode': code, 'matched': matched,
                        'distinctStates': states.group(1) if states else '?', 'traceStates': trace,
                        'configSha256': sha(folder / 'ImageBatch.cfg'), 'logSha256': sha(folder / 'tlc.txt')})
        print(f'{"OK" if matched else "FAIL"} {case["name"]}: exit={code}, '
              f'states={results[-1]["distinctStates"]}, trace states={trace}', flush=True)
    replay = subprocess.run(['node', '--test', str(HERE / 'replay.test.cjs')],
                            cwd=ROOT, capture_output=True, text=True, timeout=30)
    (output / 'replay.txt').write_text(replay.stdout + replay.stderr)
    unchanged = all(sha(ROOT / name) == expected for name, expected in hashes.items())
    success = unchanged and all(result['matched'] for result in results) and replay.returncode == 0
    manifest = {'gitHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                'jarSha256': sha(jar), 'inputs': hashes, 'inputsUnchanged': unchanged,
                'tlcVersions': sorted(tlc_versions),
                'nodeVersion': subprocess.check_output(['node', '--version'], text=True).strip(),
                'typescriptVersion': subprocess.check_output(['node', '-p', 'require("typescript").version'], cwd=ROOT, text=True).strip(),
                'results': results, 'replayExitCode': replay.returncode, 'success': success}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    report = ['# 多图批次顺序：模型检查结果', '',
              '有序批次已在源码中实现；旧算法及变异仍作为反例对照，预期违反指定性质。模型检查与真实函数回放分别列出，不代表已部署。', '',
              f'整体结果：**{"全部符合预期" if success else "存在未通过项"}**。', '',
              f'基准提交：`{manifest["gitHead"]}`；具体输入以 SHA-256 为准。', '',
              f'完整证据：`{output}`。', '',
              f'TLC 实测版本：`{"; ".join(manifest["tlcVersions"])}`；单 worker、seed=1、fp=0、512 MiB 堆；Node `{manifest["nodeVersion"]}`，TypeScript `{manifest["typescriptVersion"]}`。', '',
              '| 检查 | 预期 | 退出码 | 不同状态数 | 轨迹状态数 | 符合 |',
              '| --- | --- | ---: | ---: | ---: | --- |']
    for result in results:
        report.append(f'| {result["name"]} | {result["expect"]} | {result["exitCode"]} | '
                      f'{result["distinctStates"]} | {result["traceStates"]} | {"是" if result["matched"] else "否"} |')
    report += ['', f'**当前源码函数**回放退出码：`{replay.returncode}`，验证先登记、逆序准备仍按序发送、unknown 阻塞与旧实例拒绝；无批次任务并发保留为对照。完整 HTTP／浏览器检查另见 README。', '',
               '| 输入 | SHA-256 |', '| --- | --- |']
    report += [f'| `{name}` | `{value}` |' for name, value in hashes.items()]
    report += [f'| `tla2tools.jar` | `{manifest["jarSha256"]}` |', '',
               '模型或源码变化后需重跑；有界通过不代表任意规模证明。', '']
    (HERE / 'RESULTS.md').write_text('\n'.join(report))
    traces = HERE / 'traces'
    traces.mkdir(exist_ok=True)
    for result in results:
        if result['name'].startswith(('legacy-', 'mutation-')) or result['name'] == 'reachable-unknown-blocks':
            shutil.copyfile(output / result['name'] / 'tlc.txt', traces / f'{result["name"]}.txt')
    shutil.copyfile(output / 'replay.txt', traces / 'replay.txt')
    print(f'Replay exit={replay.returncode}; inputs unchanged={unchanged}; success={success}', flush=True)
    if replay.returncode:
        print(replay.stdout + replay.stderr)
    raise SystemExit(0 if success else 1)


if __name__ == '__main__':
    main()
