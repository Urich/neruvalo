#!/usr/bin/env python3
"""Set up the local GateVeriq Docker service and Neruvalo TOML configuration."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import tomllib
from urllib.parse import urlsplit

IMAGE = 'ghcr.io/urich/gateveriq:v0.2.0'
LABEL = 'org.neruvalo.setup'
LABEL_VALUE = 'gateveriq-v1'
STATE = '/data/neruvalo-integration.json'
GATE_CONFIG = '/data/config.toml'
ACCOUNT_FAILURE_LIMIT = 3
ROOT = Path(__file__).resolve().parent.parent


class SetupError(Exception):
    pass


class Docker:
    def __init__(self):
        if not shutil.which('docker'):
            raise SetupError('Docker is not installed. Install and start Docker first.')
        self.prefix = ['docker']
        if self.run('info', check=False).returncode:
            if not shutil.which('sudo'):
                raise SetupError('Docker is unavailable. Check the daemon and Docker socket permissions.')
            print('Docker requires sudo. Enter your sudo password if prompted.', flush=True)
            if subprocess.run(['sudo', '-v'], check=False).returncode:
                raise SetupError('Could not obtain Docker access through sudo.')
            self.prefix = ['sudo', 'docker']
            self.run('info')

    def run(self, *args, check=True, input=None):
        result = subprocess.run(self.prefix + list(args), input=input, text=True, capture_output=True)
        if check and result.returncode:
            # Never include stdout: integration-create prints the bearer secret there.
            raise SetupError(f'Docker {args[0]} failed: {result.stderr.strip()}')
        return result


def private_write(path, content):
    path = Path(path)
    descriptor, temp = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def update_config(source, gate):
    """Replace just the GateVeriq table; verify every other parsed value is intact."""
    original = tomllib.loads(source)
    headers = list(re.finditer(r'^\s*\[([^\]\n]+)\][ \t]*(?:#[^\n]*)?$', source, re.MULTILINE))
    ranges = []
    for index, header in enumerate(headers):
        name = header.group(1).strip()
        if name == 'gateveriq':
            ranges.append((header.start(), headers[index + 1].start() if index + 1 < len(headers) else len(source)))
    result = source
    for start, end in reversed(ranges):
        result = result[:start] + result[end:]
    result = result.rstrip() + '\n\n[gateveriq]\n'
    result += ''.join(f'{key} = {json.dumps(value, ensure_ascii=False)}\n' for key, value in gate.items())
    parsed = tomllib.loads(result)
    expected = dict(original, gateveriq=gate)
    if parsed != expected:
        raise SetupError('Cannot safely replace [gateveriq]; server config was left unchanged.')
    return result


def check_port(port):
    with socket.socket() as listener:
        try:
            listener.bind(('127.0.0.1', port))
        except OSError as error:
            raise SetupError(f'Port {port} is occupied. Stop the old GateVeriq container or choose another port.') from error


def ensure_container(docker, name, public_port, internal_port):
    volume = name + '-data'
    result = docker.run('container', 'inspect', name, check=False)
    if result.returncode == 0:
        container = json.loads(result.stdout)[0]
        config = container['Config']
        if (config.get('Labels') or {}).get(LABEL) != LABEL_VALUE:
            raise SetupError(f'Container {name} already exists and is not managed by this script. Use --name with a different name.')
        ports = container['HostConfig'].get('PortBindings') or {}
        expected = {'9080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(public_port)}],
                    '9081/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(internal_port)}]}
        if ports != expected or config['Image'] != IMAGE:
            raise SetupError('Existing container has different ports or image. Use another --name and free ports.')
        if container['State']['Status'] != 'running':
            docker.run('start', name)
        print(f'Reusing container {name}.', flush=True)
        return
    for port in (public_port, internal_port):
        check_port(port)
    print(f'Downloading {IMAGE} ...', flush=True)
    docker.run('pull', IMAGE)
    existing_volume = docker.run('volume', 'inspect', volume, check=False)
    if existing_volume.returncode == 0:
        labels = json.loads(existing_volume.stdout)[0].get('Labels') or {}
        if labels.get(LABEL) != LABEL_VALUE:
            raise SetupError(f'Volume {volume} is not managed by this script. Use a different --name.')
    else:
        docker.run('volume', 'create', '--label', f'{LABEL}={LABEL_VALUE}', volume)
    docker.run('run', '-d', '--name', name, '--restart', 'unless-stopped',
               '--label', f'{LABEL}={LABEL_VALUE}', '--stop-timeout', '30',
               '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL',
               '--security-opt', 'no-new-privileges:true',
               '-e', 'GATEVERIQ_INTERNAL_LISTEN=0.0.0.0:9081',
               '-p', f'127.0.0.1:{public_port}:9080',
               '-p', f'127.0.0.1:{internal_port}:9081',
               '-v', f'{volume}:/data', IMAGE)


def wait_ready(docker, name):
    print('Waiting for GateVeriq ...', flush=True)
    for _ in range(60):
        result = docker.run('exec', name, 'curl', '--fail', '--silent', '--max-time', '2',
                            'http://127.0.0.1:9080/health', check=False)
        if result.returncode == 0:
            return
        time.sleep(1)
    raise SetupError(f'GateVeriq did not become ready. Inspect logs: docker logs {name}')


def update_account_failure_limit(source):
    original = tomllib.loads(source)
    website = original.get('website', {})
    if website.get('account_failure_limit') == ACCOUNT_FAILURE_LIMIT:
        return source

    setting = f'account_failure_limit = {ACCOUNT_FAILURE_LIMIT}'
    headers = list(re.finditer(r'^[ \t]*\[[^\r\n]+\][ \t]*(?:#[^\r\n]*)?\r?$', source, re.MULTILINE))
    for index, header in enumerate(headers):
        if not re.fullmatch(r'\[website\][ \t]*(?:#.*)?', header.group().strip()):
            continue
        end = headers[index + 1].start() if index + 1 < len(headers) else len(source)
        section = source[header.end():end]
        section, replaced = re.subn(
            r'^[ \t]*account_failure_limit[ \t]*=[ \t]*[0-9_]+',
            setting, section, count=1, flags=re.MULTILINE,
        )
        if not replaced:
            section = '\n' + setting + '\n' + section
        result = source[:header.end()] + section + source[end:]
        break
    else:
        result = source.rstrip() + f'\n\n[website]\n{setting}\n'

    expected = dict(original, website=dict(website, account_failure_limit=ACCOUNT_FAILURE_LIMIT))
    if tomllib.loads(result) != expected:
        raise SetupError('Cannot update [website].account_failure_limit safely.')
    return result


def ensure_account_failure_limit(docker, name):
    source = docker.run('exec', name, 'cat', GATE_CONFIG).stdout
    updated = update_account_failure_limit(source)
    if updated == source:
        return
    docker.run('exec', '-i', name, 'sh', '-c',
               'umask 077; tmp=$(mktemp /data/.config.XXXXXX) || exit 1; '
               'trap \'rm -f "$tmp"\' EXIT; cat > "$tmp" && mv "$tmp" "$1"',
               'sh', GATE_CONFIG, input=updated)
    docker.run('restart', name)
    wait_ready(docker, name)


def ensure_integration(docker, name, origin):
    result = docker.run('exec', name, 'sh', '-c',
                        'if [ -f "$1" ]; then cat "$1"; else exit 42; fi', 'sh', STATE, check=False)
    if result.returncode == 0:
        state = json.loads(result.stdout)
        if state.get('origin') != origin:
            raise SetupError('Saved integration has another origin. Reuse its origin or use another --name and free ports.')
        print('Reusing saved Neruvalo integration.', flush=True)
    elif result.returncode == 42:
        print('Creating Neruvalo integration ...', flush=True)
        result = docker.run('exec', name, 'gateveriq', '--config', '/data/config.toml',
                            'integration-create', '--name', 'neruvalo', '--actions', 'register,login', '--origins', origin)
        state = json.loads(result.stdout)
        state['origin'] = origin
        # Save before policies/config updates so a retry does not create duplicate integrations.
        validate_credentials(state)
        docker.run('exec', '-i', name, 'sh', '-c',
                   'umask 077; cat > /data/.neruvalo-integration.tmp && mv /data/.neruvalo-integration.tmp "$1"',
                   'sh', STATE, input=json.dumps(state) + '\n')
    else:
        raise SetupError('Cannot read saved integration from the container.')
    validate_credentials(state)
    for action in ('register', 'login'):
        docker.run('exec', name, 'gateveriq', '--config', GATE_CONFIG,
                   'integration-visual-policy', '--id', state['integration_id'], '--action', action, '--visual', 'adaptive')
    return state


def validate_credentials(state):
    for field in ('integration_id', 'integration_secret'):
        value = state.get(field)
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
            raise SetupError('GateVeriq returned invalid integration credentials.')


def port(value):
    number = int(value)
    if not 1024 <= number <= 65535:
        raise argparse.ArgumentTypeError('port must be between 1024 and 65535')
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--name', default='neruvalo-gateveriq', help='container name (default: %(default)s)')
    parser.add_argument('--public-port', type=port, default=9080)
    parser.add_argument('--internal-port', type=port, default=9081)
    parser.add_argument('--server-config', type=Path, default=ROOT / 'neruvalo-server.toml')
    parser.add_argument('--origin', help='Neruvalo server origin; defaults to its configured loopback listener')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', args.name):
        raise SetupError('Invalid container name.')
    if args.public_port == args.internal_port:
        raise SetupError('Public and internal ports must differ.')
    config_path = args.server_config.expanduser().absolute()
    if not config_path.parent.is_dir():
        raise SetupError('Parent directory of the server config does not exist.')
    source = config_path.read_text() if config_path.exists() else (ROOT / 'neruvalo-server.example.toml').read_text()
    config = tomllib.loads(source)
    listen = config.get('listen', '127.0.0.1:8787')
    origin = args.origin or f'http://{listen}'
    url = urlsplit(origin)
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
            or url.path or url.query or url.fragment
            or (url.scheme == 'http' and url.hostname not in ('localhost', '127.0.0.1', '::1'))):
        raise SetupError('--origin must be an HTTPS or loopback HTTP origin without a trailing slash.')
    docker = Docker()
    ensure_container(docker, args.name, args.public_port, args.internal_port)
    wait_ready(docker, args.name)
    state = ensure_integration(docker, args.name, origin)
    ensure_account_failure_limit(docker, args.name)
    gate = dict(id=state['integration_id'], secret=state['integration_secret'],
                internal=f'http://127.0.0.1:{args.internal_port}',
                public=f'http://127.0.0.1:{args.public_port}', origin=origin)
    updated = update_config(source, gate)
    if config_path.exists() and source != updated:
        backup = config_path.with_name(config_path.name + '.before-gateveriq')
        if not backup.exists():
            private_write(backup, source)
            print(f'Original config backup: {backup}')
    private_write(config_path, updated)
    print(f'\nConfigured: {config_path}\nContainer: {args.name}\nVolume: {args.name}-data')
    print(f'\nIntegration ID: {gate["id"]}\nIntegration secret: {gate["secret"]}')
    print('\nRestart neruvalo-server in RustRover. The secret is also stored in the private server config.')


if __name__ == '__main__':
    try:
        main()
    except (SetupError, OSError, ValueError, KeyError) as error:
        # Config parse diagnostics may include secrets; never display their source lines.
        if isinstance(error, tomllib.TOMLDecodeError):
            print('Error: invalid server TOML; fix the config before retrying.', file=sys.stderr)
        else:
            print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
