"""Exercise deployment failure boundaries without touching installed services."""
import argparse
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy_personal', Path(__file__).with_name('deploy-personal-build.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        config = self.root / '.hapi'
        config.mkdir()
        (config / 'settings.json').write_text('{"keep":"configuration"}')
        unit = self.root / '.config/systemd/user/hapi-runner.service'
        unit.parent.mkdir(parents=True)
        unit.write_text('keep service config')
        self.target = self.root / 'installed'
        self.target.write_bytes(b'old executable')
        self.staged = self.root / 'new'
        self.staged.write_bytes(b'new executable')
        self.args = argparse.Namespace(role='runner', staged=str(self.staged), target=str(self.target),
                                       version='0.34.3-btw.2', sha256=deployment.digest(self.staged), check_only=False)
        home = patch.object(deployment.Path, 'home', return_value=self.root)
        home.start()
        self.addCleanup(home.stop)

    def native_run(self, args, **kwargs):
        version = '0.34.3-btw.1' if args[0] == str(self.target) else self.args.version
        return subprocess.CompletedProcess(args, 0, stdout=f'hapi version: {version}\n' if '--version' in args else '', stderr='')

    def test_rejects_corrupt_staging_before_backup_or_restart(self):
        self.args.sha256 = 'incorrect'
        with patch.object(deployment, 'run') as native:
            with self.assertRaisesRegex(RuntimeError, 'SHA256 mismatch'):
                deployment.deploy(self.args)
        native.assert_not_called()
        self.assertEqual(self.target.read_bytes(), b'old executable')
        self.assertFalse((self.root / '.hapi/backups').exists())

    def test_check_only_does_not_replace_or_restart(self):
        self.args.check_only = True
        with patch.object(deployment, 'run', side_effect=self.native_run) as native:
            self.assertTrue(deployment.deploy(self.args)['checked'])
        self.assertEqual(native.call_count, 2)
        self.assertEqual(self.target.read_bytes(), b'old executable')
        self.assertFalse((self.root / '.hapi/backups').exists())

    def test_keeps_config_and_backup_on_successful_atomic_install(self):
        with patch.object(deployment, 'run', side_effect=self.native_run), patch.object(deployment, 'runner_ready', return_value=True):
            result = deployment.deploy(self.args)
        self.assertEqual(self.target.read_bytes(), b'new executable')
        self.assertEqual((Path(result['backup']) / 'hapi.previous').read_bytes(), b'old executable')
        self.assertTrue(result['configurationUnchanged'])
        self.assertEqual(result['sha256'], deployment.digest(self.target))
        self.assertEqual(list(self.root.glob('.hapi-install-*')), [])

    def test_restores_previous_binary_when_restart_fails(self):
        restarts = []

        def fail_first_restart(args, **kwargs):
            if 'restart' in args:
                restarts.append(self.target.read_bytes())
                if len(restarts) == 1:
                    raise subprocess.CalledProcessError(1, args)
            return self.native_run(args, **kwargs)

        with patch.object(deployment, 'run', side_effect=fail_first_restart), patch.object(deployment, 'runner_ready', return_value=True):
            with self.assertRaises(subprocess.CalledProcessError):
                deployment.deploy(self.args)
        self.assertEqual(restarts, [b'new executable', b'old executable'])
        self.assertEqual(self.target.read_bytes(), b'old executable')

    def test_rolls_back_when_service_is_active_but_new_runner_never_becomes_ready(self):
        with patch.object(deployment, 'run', side_effect=self.native_run), \
             patch.object(deployment, 'runner_ready', side_effect=[False, True]) as ready, \
             patch.object(deployment.time, 'monotonic', side_effect=[0, 31, 32]):
            with self.assertRaisesRegex(RuntimeError, 'did not become healthy'):
                deployment.deploy(self.args)
        self.assertEqual(ready.call_count, 2)
        self.assertEqual(ready.call_args_list[1].args[1], '0.34.3-btw.1')
        self.assertEqual(self.target.read_bytes(), b'old executable')

    def test_runner_readiness_requires_new_version_live_process_control_and_hub_registration(self):
        import json
        home = self.root / '.hapi'
        state = {'pid': 42, 'startedWithCliVersion': self.args.version, 'httpPort': 1234,
                 'startedWithApiUrl': 'http://hub.test', 'startedWithMachineId': 'machine'}
        (home / 'runner.state.json').write_text(json.dumps(state))
        (home / 'settings.json').write_text('{"cliApiToken":"test-secret"}')
        responses = [{'children': []}, {'token': 'test-jwt'}, {'machines': [
            {'id': 'machine', 'active': True, 'metadata': {'happyCliVersion': self.args.version}, 'runnerState': {'pid': 42}}
        ]}]
        with patch.object(deployment, 'process_start', return_value='generation'), \
             patch.object(deployment, 'request_json', side_effect=responses):
            self.assertTrue(deployment.runner_ready(home, self.args.version, 41))
        with patch.object(deployment, 'process_start', return_value='generation'), patch.object(deployment, 'request_json') as request:
            self.assertFalse(deployment.runner_ready(home, self.args.version, 42))
            self.assertFalse(deployment.runner_ready(home, 'old-version', 41))
            request.assert_not_called()
        with patch.object(deployment, 'process_start', return_value=None), patch.object(deployment, 'request_json') as request:
            self.assertFalse(deployment.runner_ready(home, self.args.version, 41))
            request.assert_not_called()
        with patch.object(deployment, 'process_start', return_value='generation'), \
             patch.object(deployment, 'request_json', side_effect=OSError('control unavailable')):
            self.assertFalse(deployment.runner_ready(home, self.args.version, 41))
        responses[-1]['machines'][0]['active'] = False
        with patch.object(deployment, 'process_start', return_value='generation'), \
             patch.object(deployment, 'request_json', side_effect=responses):
            self.assertFalse(deployment.runner_ready(home, self.args.version, 41))


if __name__ == '__main__':
    unittest.main()
