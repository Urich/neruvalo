import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('gate_setup', Path(__file__).parents[1] / 'setup-gateveriq-docker.py')
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


class FakeDocker:
    def __init__(self):
        self.calls = []
        self.created = False
        self.state = None
        self.managed = True
        self.fail_policy = False
        self.gate_config = 'difficulty_bits = 18\n[website]\naccount_failure_limit = 5\nfailure_limit = 6\n'

    def run(self, *args, check=True, input=None):
        self.calls.append(args)
        result = subprocess.CompletedProcess(args, 0, '', '')
        if args[:2] == ('container', 'inspect'):
            result.returncode = 0 if self.created else 1
            result.stdout = json.dumps([{
                'Config': {'Image': setup.IMAGE, 'Labels': {setup.LABEL: setup.LABEL_VALUE} if self.managed else {}},
                'State': {'Status': 'running'},
                'HostConfig': {'PortBindings': {
                    '9080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '9080'}],
                    '9081/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '9081'}],
                }},
            }])
        elif args[:2] == ('volume', 'inspect'):
            result.returncode = 1
        elif args[0] == 'run':
            self.created = True
        elif args[2:] == ('cat', setup.GATE_CONFIG):
            result.stdout = self.gate_config
        elif args[:1] == ('exec',) and args[2:4] == ('sh', '-c'):
            result.returncode = 0 if self.state else 42
            result.stdout = json.dumps(self.state)
        elif 'integration-create' in args:
            result.stdout = json.dumps({'integration_id': 'mock-id', 'integration_secret': 'mock-secret'})
        elif args[:2] == ('exec', '-i'):
            if args[-1] == setup.GATE_CONFIG:
                self.gate_config = input
            else:
                self.state = json.loads(input)
        elif 'integration-visual-policy' in args and self.fail_policy:
            raise setup.SetupError('Mock policy failure')
        return result


class SetupTests(unittest.TestCase):
    def invoke(self, config, docker, *extra):
        output = io.StringIO()
        with patch.object(sys, 'argv', ['setup', '--server-config', str(config), *extra]), \
                patch.object(setup, 'Docker', return_value=docker), \
                patch.object(setup, 'check_port'), contextlib.redirect_stdout(output):
            setup.main()
        return output.getvalue()

    def test_setup_and_repeat_preserve_config_credentials_and_data(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'server.toml'
            original = 'dev_mode=true\nlisten="127.0.0.1:8787"\ndatabase_url="sqlite:existing.sqlite"\n'
            config.write_text(original)
            docker = FakeDocker()
            output = self.invoke(config, docker)
            first = config.read_text()
            parsed = tomllib.loads(first)
            self.assertEqual(parsed['database_url'], 'sqlite:existing.sqlite')
            self.assertEqual(parsed['gateveriq']['secret'], 'mock-secret')
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            self.assertEqual(config.with_name('server.toml.before-gateveriq').read_text(), original)
            self.assertIn('Integration secret: mock-secret', output)
            self.invoke(config, docker)
            self.assertEqual(config.read_text(), first)
            self.assertEqual(sum('integration-create' in call for call in docker.calls), 1)
            self.assertEqual(
                [call[-4:] for call in docker.calls if 'integration-visual-policy' in call],
                [('--action', 'register', '--visual', 'adaptive'),
                 ('--action', 'login', '--visual', 'adaptive')] * 2,
            )
            self.assertEqual(tomllib.loads(docker.gate_config),
                             {'difficulty_bits': 18, 'website': {'account_failure_limit': 3, 'failure_limit': 6}})
            self.assertEqual(docker.calls.count(('restart', 'neruvalo-gateveriq')), 1)
            run = next(call for call in docker.calls if call[0] == 'run')
            self.assertIn('127.0.0.1:9081:9081', run)
            self.assertIn('GATEVERIQ_INTERNAL_LISTEN=0.0.0.0:9081', run)
            self.assertIn('neruvalo-gateveriq-data:/data', run)
            self.assertEqual(run[-1], 'ghcr.io/urich/gateveriq:v0.2.0')

    def test_creates_server_config_from_example(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'server.toml'
            self.invoke(config, FakeDocker())
            self.assertTrue(tomllib.loads(config.read_text())['dev_mode'])

    def test_adds_threshold_when_website_settings_are_absent(self):
        for source in ('difficulty_bits = 18\n', 'difficulty_bits = 18\n[website]\n'):
            updated = setup.update_account_failure_limit(source)
            self.assertEqual(tomllib.loads(updated),
                             {'difficulty_bits': 18, 'website': {'account_failure_limit': 3}})

    def test_policy_failure_keeps_original_config_and_retry_reuses_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'server.toml'
            original = 'dev_mode=true\n'
            config.write_text(original)
            docker = FakeDocker()
            docker.fail_policy = True
            with self.assertRaises(setup.SetupError):
                self.invoke(config, docker)
            self.assertEqual(config.read_text(), original)
            self.assertIsNotNone(docker.state)
            docker.fail_policy = False
            self.invoke(config, docker)
            self.assertEqual(sum('integration-create' in call for call in docker.calls), 1)

    def test_existing_unmanaged_container_is_not_stopped_or_removed(self):
        docker = FakeDocker()
        docker.created = True
        docker.managed = False
        with self.assertRaises(setup.SetupError):
            setup.ensure_container(docker, 'existing', 9080, 9081)
        self.assertEqual(len(docker.calls), 1)

    def test_changed_origin_rejected(self):
        docker = FakeDocker()
        docker.state = dict(origin='http://localhost:8787', integration_id='id', integration_secret='secret')
        with self.assertRaises(setup.SetupError):
            setup.ensure_integration(docker, 'existing', 'http://127.0.0.1:8787')
        self.assertFalse(any('integration-create' in call for call in docker.calls))

    def test_only_gate_table_changes_and_secret_is_escaped(self):
        original = 'dev_mode=true\n[gateveriq]\nid="old"\nsecret="old"\n[other]\nvalue="keep"\n'
        gate = dict(id='new', secret='quoted"secret\\')
        updated = tomllib.loads(setup.update_config(original, gate))
        self.assertEqual(updated, dict(dev_mode=True, gateveriq=gate, other={'value': 'keep'}))

    def test_occupied_port_is_rejected_before_pulling_image(self):
        docker = FakeDocker()
        with patch.object(setup, 'check_port', side_effect=setup.SetupError('occupied')):
            with self.assertRaises(setup.SetupError):
                setup.ensure_container(docker, 'name', 9080, 9081)
        self.assertFalse(any(call[0] == 'pull' for call in docker.calls))


if __name__ == '__main__':
    unittest.main()
