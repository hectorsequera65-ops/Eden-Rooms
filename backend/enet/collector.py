#!/usr/bin/env python3
"""Ubuntu ENet collector. Sending requires --send; otherwise prints snapshots."""
import argparse
from datetime import datetime, timezone
import json
from html import unescape
import os
import re
import subprocess
import sys
import time
import threading
import urllib.request
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from protocol import parse_packet3


USER_AGENT = 'EdenRoomsCollector/1.1 (+https://github.com/hectorsequera65-ops/Eden-Rooms)'


class ApiError(RuntimeError):
    """A bounded, redacted API diagnostic safe to print to the service journal."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward collector credentials to a redirect destination.
        return None


def safe_detail(value, limit=800):
    text = str(value)
    for key in ('VERSIONES_API_KEY', 'AUTORIZACIONES_API_KEY', 'COLLECTOR_API_KEY'):
        secret = os.environ.get(key)
        if secret:
            text = text.replace(secret, '[REDACTED]')
    text = re.sub(r'<(script|style)\b[^>]*>.*?</\1>', ' ', text, flags=re.I | re.S)
    text = unescape(re.sub(r'<[^>]*>', ' ', text))
    text = ''.join(c if c.isprintable() else ' ' for c in text)
    return ' '.join(text.split())[:limit]


def api(base, path, payload=None, timeout=15):
    body = None if payload is None else json.dumps(payload).encode()
    method = 'GET' if body is None else 'POST'
    headers = {'Accept': 'application/json', 'User-Agent': USER_AGENT}
    if body is None and path == '/api/autorizaciones':
        key = os.environ.get('AUTORIZACIONES_API_KEY')
        if key:
            headers['X-Collector-Key'] = key
    if body is None and path == '/api/versiones-validar':
        key = os.environ.get('VERSIONES_API_KEY')
        if key:
            headers['X-API-Key'] = key
    if path == '/api/collector/jobs':
        headers['X-Collector-Key'] = os.environ['COLLECTOR_API_KEY']
    elif body is not None:
        headers.update({'Content-Type': 'application/json',
                        'X-API-Key': os.environ['VERSIONES_API_KEY']})
    req = urllib.request.Request(base + path, data=body, headers=headers)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(req, timeout=timeout) as response:
            try:
                return json.load(response)
            except (ValueError, UnicodeError) as error:
                raise ApiError(f'{method} {path}: HTTP {response.status}, invalid JSON response (possibly a missing API endpoint or static HTML fallback)') from error
    except HTTPError as error:
        try:
            raw = error.read(8192).decode('utf-8', errors='replace')
        except (OSError, ValueError):
            raw = 'Response body unavailable'
        finally:
            error.close()
        ray = safe_detail(error.headers.get('CF-Ray', 'not provided'), 100)
        retry = error.headers.get('Retry-After')
        diagnostic = (f'{method} {path}: HTTP {error.code} {safe_detail(error.reason, 100)}; '
                      f'CF-Ray={ray}; detail={safe_detail(raw) or "empty response"}')
        if retry:
            diagnostic += f'; Retry-After={safe_detail(retry, 100)}'
        if error.code in (301, 302, 303, 307, 308):
            diagnostic += '; redirect refused: use the canonical HTTPS base URL'
        raise ApiError(diagnostic) from None
    except URLError as error:
        raise ApiError(f'{method} {path}: network/TLS error: {safe_detail(error.reason)}') from None
    except (TimeoutError, OSError) as error:
        raise ApiError(f'{method} {path}: network error: {safe_detail(error)}') from None


class SnapshotPublisher:
    """Send changes immediately; renew unchanged snapshots at most once per minute."""
    def __init__(self, base, validate_only=False, transport=None, now=None):
        self.base = base
        self.validate_only = validate_only
        self.transport = transport or api
        self.now = now or time.monotonic
        self.sent = {}

    def __call__(self, snapshot):
        # Packet member ordering is not an actual player/version change.
        records = sorted(json.dumps(p, sort_keys=True, ensure_ascii=False) for p in snapshot['jugadores'])
        signature = tuple(records)
        previous = self.sent.get(snapshot['sala_id'])
        if previous and previous[0] == signature and self.now() - previous[1] < 60:
            return False
        path = '/api/versiones-validar' if self.validate_only else '/api/versiones-multiples'
        result = self.transport(self.base, path, snapshot)
        if self.validate_only:
            if not isinstance(result, dict) or result.get('validado') is not True or result.get('escritura') is not False:
                raise ApiError('Validation endpoint did not confirm no-write mode; refusing fallback')
            print(json.dumps(result), flush=True)
        elif not isinstance(result, dict) or result.get('ok') is not True:
            raise ApiError('Versions endpoint did not confirm storage')
        # Failed writes never suppress the next attempt.
        self.sent[snapshot['sala_id']] = (signature, self.now())
        return True


def collect(binary, room, duration, emit, nickname="sralcer", hard_timeout=None):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,24}", nickname):
        raise ValueError("Invalid collector nickname")
    # No shell expansion; one ENet peer; never announce an invented game.
    command = [binary, room['direccion'], str(room['puerto']), '1', str(duration)]
    snapshots_received = 0
    child_env = {key: value for key, value in os.environ.items()
                 if key not in ('COLLECTOR_API_KEY', 'VERSIONES_API_KEY', 'AUTORIZACIONES_API_KEY')}
    child_env['EDEN_ENET_NICKNAME'] = nickname
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          text=True, env=child_env) as process:
        watchdog = None
        if hard_timeout is not None:
            watchdog = threading.Timer(hard_timeout, process.kill)
            watchdog.daemon = True
            watchdog.start()
        try:
            for line in process.stdout:
                if not line.startswith('EDEN_PACKET3 '):
                    continue
                timestamp = datetime.now(timezone.utc).isoformat()
                try:
                    _, size, encoded = line.strip().split(' ', 2)
                    packet = bytes.fromhex(encoded)
                    if len(packet) != int(size):
                        raise ValueError('Packet length mismatch')
                    snapshot = parse_packet3(packet)
                    players = [p for p in snapshot['jugadores']
                               if p['nombre'] != nickname]
                    if len(players) > 32:
                        raise ValueError('API supports at most 32 players')
                    emit(dict(sala_id=room['id'], consultado_en=timestamp, jugadores=players))
                    snapshots_received += 1
                except (ValueError, UnicodeError) as error:
                    print(f"Rejected snapshot for {room['id']}: {error}", file=sys.stderr)
            if process.wait() != 0:
                raise RuntimeError('ENet client failed; no empty snapshot sent')
            if not snapshots_received:
                raise RuntimeError('No valid snapshots received; nothing sent')
        finally:
            if watchdog is not None:
                watchdog.cancel()
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--client', default='/opt/eden-rooms-enet/eden-collector')
    parser.add_argument('--duration', type=int, default=20)
    parser.add_argument('--interval', type=int, default=30)
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--check-api', action='store_true', help='Check authorization API once, without ENet or writes')
    parser.add_argument('--check-auth', action='store_true', help='Check versions API key once, without ENet or D1 queries/writes')
    send_mode = parser.add_mutually_exclusive_group()
    send_mode.add_argument('--send', action='store_true')
    send_mode.add_argument('--validate-send', action='store_true', help='POST snapshots to validation-only route, without D1 writes')
    parser.add_argument('--room-id', help='Query only this exact registered room ID')
    parser.add_argument('--nickname', default=os.environ.get('EDEN_ENET_NICKNAME', 'sralcer'))
    args = parser.parse_args()
    if sum((args.check_api, args.check_auth, args.send, args.validate_send)) > 1:
        parser.error("Choose only one of --check-api, --check-auth, --send, --validate-send")
    if args.room_id is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", args.room_id):
        parser.error("--room-id must be one nonempty registered room ID")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,24}", args.nickname):
        parser.error("Nickname must contain 1-24 letters, digits, underscores or hyphens")
    base = args.base_url.rstrip('/')
    url = urlsplit(base)
    if url.scheme != 'https' or not url.netloc or url.username or url.query or url.fragment:
        parser.error('A clean HTTPS base URL is required')
    if not 1 <= args.duration <= 600 or args.interval < 1:
        parser.error('Invalid duration/interval')
    if (args.send or args.validate_send or args.check_auth) and not os.environ.get('VERSIONES_API_KEY'):
        parser.error('VERSIONES_API_KEY is required for --send, --validate-send or --check-auth')
    publisher = SnapshotPublisher(base, validate_only=args.validate_send)
    while True:
        failed = False
        try:
            if args.check_auth:
                result = api(base, '/api/versiones-validar')
                if (not isinstance(result, dict) or result.get('endpoint') != 'versiones-validar'
                    or result.get('contrato') != 1 or result.get('modo') != 'autenticacion'
                    or result.get('autenticado') is not True or result.get('escritura') is not False):
                    raise ApiError('Authentication endpoint did not confirm the no-write contract; refusing fallback')
                print(json.dumps(result), flush=True)
                return 0
            data = api(base, '/api/autorizaciones')
            if not isinstance(data, dict) or not isinstance(data.get('salas'), list):
                raise ApiError('GET /api/autorizaciones: unexpected JSON schema (expected salas array)')
            rooms = data['salas']
            if args.check_api:
                print(json.dumps({'ok': True, 'salas': len(rooms)}))
                return 0
            if args.room_id:
                rooms = [room for room in rooms if room.get('id') == args.room_id]
                if len(rooms) != 1:
                    raise ApiError('Selected room ID is missing or ambiguous in authorization list')
            for room in rooms:
                if not room.get('autorizada') or not room.get('direccion') or not room.get('puerto'):
                    continue
                try:
                    def emit(snapshot):
                        if args.validate_send or args.send:
                            publisher(snapshot)
                        else:
                            print(json.dumps(snapshot, ensure_ascii=False), flush=True)
                    collect(args.client, room, args.duration, emit, args.nickname)
                except Exception as error:
                    failed = True
                    print(f"Collection failed for {room['id']}: {type(error).__name__}: {safe_detail(error, 1400)}", file=sys.stderr)
        except Exception as error:
            failed = True
            print(f'{"Versions authentication check failed" if args.check_auth else "Authorization fetch failed"}: {type(error).__name__}: {safe_detail(error, 1400)}', file=sys.stderr)
        if args.once or args.check_api or args.check_auth:
            return int(failed)
        time.sleep(args.interval)


if __name__ == '__main__':
    raise SystemExit(main())
