#!/usr/bin/env python3
"""Install one verified personal HAPI binary, retaining configuration and agent processes."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)


def digest(path):
    checksum = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def process_start(pid):
    try:
        if sys.platform.startswith('linux'):
            return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
        return run(['ps', '-p', str(pid), '-o', 'lstart=']).stdout.strip() or None
    except (OSError, subprocess.CalledProcessError):
        return None


def replace_binary(source, target):
    fd, temporary = tempfile.mkstemp(prefix='.hapi-install-', dir=target.parent)
    os.close(fd)
    try:
        shutil.copyfile(source, temporary)
        os.chmod(temporary, 0o755)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def request_json(url, data=None, headers=None):
    request = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(),
                                     headers={'Content-Type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(request, timeout=3) as response:
        return json.load(response)


def runner_ready(home, version, previous_pid):
    try:
        state = json.loads((home / 'runner.state.json').read_text())
        pid = state['pid']
        if pid == previous_pid or state['startedWithCliVersion'] != version or not process_start(pid):
            return False
        control = request_json(f"http://127.0.0.1:{state['httpPort']}/list", {})
        if not isinstance(control.get('children'), list):
            return False
        settings = json.loads((home / 'settings.json').read_text())
        api = state['startedWithApiUrl'].rstrip('/')
        token = request_json(api + '/api/auth', {'accessToken': settings['cliApiToken']})['token']
        machines = request_json(api + '/api/machines', headers={'Authorization': 'Bearer ' + token})['machines']
        return any(machine['id'] == state['startedWithMachineId'] and machine.get('active')
                   and (machine.get('metadata') or {}).get('happyCliVersion') == version
                   and (machine.get('runnerState') or {}).get('pid') == pid for machine in machines)
    except (OSError, ValueError, KeyError, TypeError):
        return False


def deploy(args):
    home = Path.home() / '.hapi'
    staged, target = Path(args.staged).expanduser(), Path(args.target).expanduser()
    if not target.is_file():
        raise RuntimeError(f'Existing executable missing: {target}')
    if digest(staged) != args.sha256:
        raise RuntimeError('Staged binary SHA256 mismatch')
    with tempfile.TemporaryDirectory(prefix='hapi-version-') as isolated:
        actual = run([str(staged), '--version'], env={**os.environ, 'HAPI_HOME': isolated}).stdout.strip()
        previous_version = run([str(target), '--version'], env={**os.environ, 'HAPI_HOME': isolated}).stdout.strip().split(': ', 1)[1]
    if actual != f'hapi version: {args.version}':
        raise RuntimeError(f'Unexpected staged version: {actual}')
    unit = (Path.home() / 'Library/LaunchAgents/com.hapi.runner.plist' if args.role == 'mac'
            else Path('/etc/systemd/system/hapi-hub.service') if args.role == 'hub'
            else Path.home() / '.config/systemd/user/hapi-runner.service')
    config = [home / 'settings.json', unit]
    before = {str(path): digest(path) for path in config}
    if args.check_only:
        return {'checked': True, 'version': args.version, 'target': str(target), 'sha256': args.sha256}

    runner_state = home / 'runner.state.json'
    previous_pid = json.loads(runner_state.read_text()).get('pid') if args.role != 'hub' and runner_state.exists() else None

    runtimes = {}
    for record in (home / 'codex-runtimes').glob('*.json'):
        entry = json.loads(record.read_text())
        for key in ('pid', 'serverPid'):
            pid = entry.get(key)
            if pid and (start := process_start(pid)):
                runtimes[str(pid)] = start
    backup = home / 'backups' / ('personal-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(parents=True, mode=0o700)
    shutil.copy2(target, backup / 'hapi.previous')
    for path in config:
        shutil.copy2(path, backup / path.name)
    watchdog = False
    installed = False
    result = {'version': args.version, 'role': args.role, 'target': str(target),
              'sha256': args.sha256, 'backup': str(backup), 'priorRuntimeProcesses': runtimes}

    def restart():
        if args.role == 'mac':
            run(['launchctl', 'kickstart', '-k', f'gui/{os.getuid()}/com.hapi.runner'])
        else:
            run(['systemctl'] + ([] if args.role == 'hub' else ['--user'])
                + ['restart', 'hapi-hub.service' if args.role == 'hub' else 'hapi-runner.service'])

    def healthy(version):
        try:
            if args.role == 'mac':
                if 'state = running' not in run(['launchctl', 'print', f'gui/{os.getuid()}/com.hapi.runner']).stdout:
                    return False
            else:
                run(['systemctl'] + ([] if args.role == 'hub' else ['--user'])
                    + ['is-active', '--quiet', 'hapi-hub.service' if args.role == 'hub' else 'hapi-runner.service'])
            if args.role == 'hub':
                with urllib.request.urlopen(args.health_url, timeout=3) as response:
                    return response.status == 200
            return runner_ready(home, version, previous_pid)
        except (OSError, subprocess.CalledProcessError):
            return False

    def wait_healthy(version):
        deadline = time.monotonic() + 30
        while not healthy(version):
            if time.monotonic() >= deadline:
                raise RuntimeError('Service did not become healthy within 30 seconds')
            time.sleep(1)

    try:
        if args.role == 'hub':
            watchdog = subprocess.run(['systemctl', 'is-active', '--quiet', 'hapi-watchdog.timer'], capture_output=True).returncode == 0
            if watchdog:
                run(['systemctl', 'stop', 'hapi-watchdog.timer'])
            with sqlite3.connect(str(home / 'hapi.db')) as source, sqlite3.connect(str(backup / 'hapi.db')) as destination:
                source.backup(destination)
                result['databaseQuickCheck'] = destination.execute('PRAGMA quick_check').fetchone()[0]
                result['databaseCounts'] = {table: destination.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
                                            for table in ('sessions', 'messages')}
                if result['databaseQuickCheck'] != 'ok':
                    raise RuntimeError('Database backup failed quick_check')
        replace_binary(staged, target)
        installed = True
        restart()
        wait_healthy(args.version)
        if digest(target) != args.sha256:
            raise RuntimeError('Installed binary SHA256 mismatch')
        result['configurationUnchanged'] = all(digest(path) == before[str(path)] for path in config)
        result['retainedRuntimeProcesses'] = sorted(pid for pid, start in runtimes.items() if process_start(int(pid)) == start)
        result['exitedRuntimeProcesses'] = sorted(set(runtimes) - set(result['retainedRuntimeProcesses']))
        (backup / 'deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
        return result
    except Exception:
        if installed:
            replace_binary(backup / 'hapi.previous', target)
            restart()
            wait_healthy(previous_version)
        raise
    finally:
        if watchdog:
            run(['systemctl', 'start', 'hapi-watchdog.timer'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', choices=['hub', 'runner', 'mac'], required=True)
    parser.add_argument('--staged', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--health-url', default='http://127.0.0.1:3006/health')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    print(json.dumps(deploy(args), ensure_ascii=False))


if __name__ == '__main__':
    main()
