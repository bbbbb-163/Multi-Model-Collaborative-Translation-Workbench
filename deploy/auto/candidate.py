"""Start the immutable runtime image with synthetic data before touching production."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time
import uuid

from common import SHA, atomic_json


READABILITY_JS = r"""
const fs = require('node:fs'), path = require('node:path');
if (process.getuid() !== 1000 || process.getgid() !== 1000) throw Error('Expected node UID/GID 1000');
let files = 0, directories = 0;
function visit(p) {
  const s = fs.lstatSync(p);
  if (s.isSymbolicLink()) {
    const real = fs.realpathSync(p);
    if (!real.startsWith('/app/')) throw Error('Runtime link outside /app: ' + p);
    fs.accessSync(real, fs.constants.R_OK);
    return;
  }
  fs.accessSync(p, fs.constants.R_OK | (s.isDirectory() ? fs.constants.X_OK : 0));
  if (s.isDirectory()) {
    directories++;
    for (const name of fs.readdirSync(p)) visit(path.join(p, name));
  } else { files++; }
}
for (const p of ['/app/package.json','/app/package-lock.json','/app/build','/app/dist','/app/node_modules']) visit(p);
const modes = Object.fromEntries(['package.json','package-lock.json','build/server/index.js','dist/index.html']
  .map(p => [p, (fs.statSync('/app/' + p).mode & 0o777).toString(8)]));
console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),files,directories,modes}));
"""

HTTP_JS = r"""
(async () => {
  for (const p of ['/api/health','/','/admin']) {
    const r = await fetch('http://127.0.0.1:3210' + p, {signal:AbortSignal.timeout(4000)});
    if (r.status !== 200 || (p === '/api/health' && !(await r.json()).ok)) throw Error('Readiness HTTP failed: ' + p);
  }
  console.log(JSON.stringify({health:true,home:true,admin:true}));
})().catch(e => {console.error(e);process.exit(1)});
"""


def _fixture(directory):
    """No production schema, account, vault or configuration is read/copied."""
    directory.mkdir(mode=0o700)
    key = os.urandom(32)
    (directory / 'vault.key').write_bytes(key)
    record = '0' * 32 + ':' + '0' * 128  # Synthetic, unusable admin credential.
    with contextlib.closing(sqlite3.connect(directory / 'workbench.sqlite')) as db:
        db.execute('CREATE TABLE security (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
        db.execute('INSERT INTO security VALUES (?,?)', ('admin-password', record))
        db.commit()
    for p in (directory, directory / 'vault.key', directory / 'workbench.sqlite'):
        os.chmod(p, 0o700 if p.is_dir() else 0o600)
        if os.name != 'nt':
            os.chown(p, 1000, 1000)
    return hashlib.sha256(key).hexdigest(), record


def validate_candidate(image_id, commit, state_directory, timeout=120):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id) or not SHA.fullmatch(commit):
        raise ValueError('Expected an immutable image ID and reviewed commit')
    parent = Path(state_directory) / 'candidate-checks'
    parent.mkdir(mode=0o700, exist_ok=True)
    if parent.is_symlink():
        raise ValueError('Candidate log directory must not be a symlink')
    os.chmod(parent, 0o700)
    token = uuid.uuid4().hex
    name = 'mstar-candidate-check-' + token
    logs = parent / (commit[:12] + '-' + token)
    logs.mkdir(mode=0o700)
    command_log = logs / 'commands.jsonl'
    command_log.touch(mode=0o600)

    def execute(args, checked=True, limit=30):
        p = subprocess.run([str(v) for v in args], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=limit)
        with command_log.open('a', encoding='utf-8') as out:
            out.write(json.dumps(dict(args=[str(v) for v in args], code=p.returncode,
                                     stdout=p.stdout.decode(errors='replace'),
                                     stderr=p.stderr.decode(errors='replace'))) + '\n')
        if checked and p.returncode:
            raise RuntimeError('Candidate command failed; see private command log')
        return p

    def inspect(cid):
        return json.loads(execute(['docker', 'inspect', cid]).stdout)[0]

    container = None
    error = None
    cleanup_errors = []
    result = dict(image_id=image_id, commit=commit, logs=str(logs), passed=False)
    with tempfile.TemporaryDirectory(prefix='fixture-', dir=logs) as temporary:
        data = Path(temporary) / 'data'
        vault, admin = _fixture(data)
        try:
            image = json.loads(execute(['docker', 'image', 'inspect', image_id]).stdout)[0]
            if (image['Id'] != image_id or image['Config'].get('User') != 'node'
                    or image['Config'].get('Labels', {}).get('org.opencontainers.image.revision') != commit):
                raise ValueError('Candidate image identity/user/revision mismatch')
            container = execute([
                'docker', 'create', '--name', name, '--user', 'node', '--init',
                '--label', 'io.mstar.candidate-check=' + token,
                '--label', 'com.docker.compose.project=' + name,
                '--label', 'com.docker.compose.service=candidate',
                '--network', 'none', '--restart', 'no', '--read-only',
                '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '96',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
                '--log-driver', 'json-file', '--log-opt', 'max-size=10m',
                '--env', 'WORKBENCH_HOST=127.0.0.1', '--env', 'PORT=3210',
                '--env', 'WORKBENCH_ORIGIN=https://candidate.invalid',
                '--env', 'WORKBENCH_DATA=/app/.data',
                '--mount', 'type=bind,source=' + str(data.resolve()) + ',target=/app/.data',
                '--health-interval', '2s', '--health-timeout', '3s',
                '--health-start-period', '2s', '--health-retries', '5', image_id,
            ]).stdout.decode().strip()
            if not re.fullmatch(r'[0-9a-f]{64}', container):
                raise ValueError('Invalid candidate container ID')
            info = inspect(container)
            if (info['Config'].get('Labels', {}).get('io.mstar.candidate-check') != token
                    or info['Name'] != '/' + name or info['Image'] != image_id
                    or info['HostConfig']['NetworkMode'] != 'none'
                    or info['HostConfig'].get('PortBindings')
                    or len(info['Mounts']) != 1
                    or Path(info['Mounts'][0]['Source']).resolve() != data.resolve()
                    or info['Mounts'][0]['Destination'] != '/app/.data'):
                raise ValueError('Candidate isolation verification failed')
            execute(['docker', 'start', container])
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                info = inspect(container)
                state = info['State']
                if not state['Running']:
                    raise RuntimeError('Candidate exited during startup: ' + str(state.get('ExitCode')))
                health = state.get('Health', {}).get('Status')
                if health == 'healthy':
                    break
                if health == 'unhealthy':
                    raise RuntimeError('Candidate unhealthy')
                time.sleep(1)
            else:
                raise RuntimeError('Candidate startup timed out')
            result['readability'] = json.loads(execute(['docker', 'exec', '--user', 'node', container, 'node', '-e', READABILITY_JS]).stdout)
            if result['readability'].get('uid') != 1000 or result['readability'].get('gid') != 1000:
                raise ValueError('Runtime did not use production node UID/GID')
            result['http'] = json.loads(execute(['docker', 'exec', '--user', 'node', container, 'node', '-e', HTTP_JS]).stdout)
            result['healthy'] = True
        except Exception as exc:
            error = exc
            result['error'] = str(exc)
        finally:
            if container:
                try:
                    info = inspect(container)
                    atomic_json(logs / 'container-inspect.json', info)
                    if (info['Config'].get('Labels', {}).get('io.mstar.candidate-check') != token
                            or info['Name'] != '/' + name):
                        raise RuntimeError('Refusing to clean a container not owned by this check')
                    if info['State']['Running']:
                        try:
                            execute(['docker', 'stop', '-t', '10', container])
                        except Exception as exc:
                            cleanup_errors.append(str(exc))
                    try:
                        output = execute(['docker', 'logs', '--timestamps', container], checked=False)
                        for filename, content in (('stdout.log', output.stdout), ('stderr.log', output.stderr)):
                            path = logs / filename
                            path.touch(mode=0o600)
                            path.write_bytes(content)
                        if output.returncode:
                            cleanup_errors.append('Could not capture candidate logs')
                    except Exception as exc:
                        cleanup_errors.append(str(exc))
                    try:
                        execute(['docker', 'rm', '--force', container])
                        result['container_removed'] = True
                    except Exception as exc:
                        cleanup_errors.append(str(exc))
                except Exception as exc:
                    cleanup_errors.append(str(exc))
        if error is None and not cleanup_errors:
            try:
                with contextlib.closing(sqlite3.connect((data / 'workbench.sqlite').as_uri() + '?mode=ro', uri=True)) as db:
                    if (db.execute('PRAGMA quick_check').fetchall() != [('ok',)]
                            or db.execute("SELECT value FROM security WHERE id='admin-password'").fetchone() != (admin,)
                            or hashlib.sha256((data / 'vault.key').read_bytes()).hexdigest() != vault):
                        raise RuntimeError('Synthetic data changed unexpectedly')
            except Exception as exc:
                error = exc
                result['error'] = str(exc)
    result['synthetic_data_removed'] = True
    result['cleanup_errors'] = cleanup_errors
    result['passed'] = error is None and not cleanup_errors
    atomic_json(logs / 'result.json', result)
    if not result['passed']:
        raise RuntimeError('Candidate startup gate failed; logs: ' + str(logs)) from error
    return result
