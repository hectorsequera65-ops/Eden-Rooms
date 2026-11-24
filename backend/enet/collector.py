#!/usr/bin/env python3
"""Ubuntu ENet collector. Sending requires --send; otherwise prints snapshots."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
import ipaddress
from itertools import cycle
from datetime import datetime, timezone
import json
from html import unescape
from pathlib import Path
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


PREVIEW_URL = 'https://test-enet-versions-sralcer.eden-rooms.pages.dev'
PREVIEW_KEY = 'ENET_PREVIEW_API_KEY'
PRODUCTION_URL = 'https://eden-rooms.pages.dev'
PRODUCTION_KEY = 'ENET_PRODUCTION_API_KEY'
SCHEDULED_TARGETS = {
    PREVIEW_URL: (PREVIEW_KEY, 'X-ENet-Preview-Key', 'ENET_PREVIEW_DB'),
    PRODUCTION_URL: (PRODUCTION_KEY, 'X-ENet-Production-Key', 'DB'),
}
SECRET_ENV = (PREVIEW_KEY, PRODUCTION_KEY, 'VERSIONES_API_KEY', 'AUTORIZACIONES_API_KEY', 'COLLECTOR_API_KEY')
VALIDATE_PATH = '/api/versiones-validar'
SCHEDULED_PATH = '/api/versiones-programadas'
DEFAULT_EXCLUDED_NICKNAME = "sralcer"
COLLECTOR_NICKNAMES = (
    'stunning', 'smelly', 'ample', 'hideous', 'crazy', 'strong',
    'grubby', 'moist', 'scrummy', 'spiffing', 'greasy', 'amazing',
)
USER_AGENT = 'EdenRoomsCollector/1.1 (+https://github.com/hectorsequera65-ops/Eden-Rooms)'


class ApiError(RuntimeError):
    """A bounded, redacted API diagnostic safe to print to the service journal."""


class RoomUnavailable(RuntimeError):
    """The client could not obtain a valid snapshot from this room."""


class ClientError(RuntimeError):
    """The ENet client failed locally or terminated abnormally."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward collector credentials to a redirect destination.
        return None


def safe_detail(value, limit=800):
    text = str(value)
    for key in SECRET_ENV:
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
    scheduled_auth = path in (SCHEDULED_PATH, SCHEDULED_PATH + '?reserve')
    preview_auth = PREVIEW_KEY in os.environ and path == VALIDATE_PATH and body is None
    if scheduled_auth or preview_auth:
        target = SCHEDULED_TARGETS.get(base) if scheduled_auth or base == PREVIEW_URL else None
        if target is None or not os.environ.get(target[0]):
            raise ApiError('Scheduled or Preview authentication requires the canonical URL and its configured key')
        key, header, _ = target
        headers[header] = os.environ[key]
    elif body is None and path == VALIDATE_PATH:
        key = os.environ.get('VERSIONES_API_KEY')
        if key:
            headers['X-API-Key'] = key
    if path == '/api/collector/jobs':
        headers['X-Collector-Key'] = os.environ['COLLECTOR_API_KEY']
        if body is not None:
            headers['Content-Type'] = 'application/json'
    elif body is not None:
        headers['Content-Type'] = 'application/json'
        if not (preview_auth or scheduled_auth):
            headers['X-API-Key'] = os.environ['VERSIONES_API_KEY']
    req = urllib.request.Request(base + path, data=body, headers=headers)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(req, timeout=timeout) as response:
            try:
                return json.load(response)
            except (ValueError, UnicodeError) as error:
                raise ApiError(f'{method} {path}: HTTP {response.status}, invalid JSON response (possibly a missing API endpoint or static HTML fallback)') from error
    except HTTPError as error:
        if scheduled_auth:
            error.close()
            raise ApiError(f'{method} {path}: HTTP {error.code}') from None
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
        if scheduled_auth:
            raise ApiError(f'{method} {path}: network/TLS error') from None
        raise ApiError(f'{method} {path}: network/TLS error: {safe_detail(error.reason)}') from None
    except (TimeoutError, OSError) as error:
        if scheduled_auth:
            raise ApiError(f'{method} {path}: network error') from None
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
        path = VALIDATE_PATH if self.validate_only else '/api/versiones-multiples'
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


def collect(binary, room, duration, emit, nickname="sralcer", hard_timeout=None, *,
            first_snapshot=False, timings=None):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,24}", nickname):
        raise ValueError("Invalid collector nickname")
    # No shell expansion; one ENet peer; never announce an invented game.
    command = [binary, room['direccion'], str(room['puerto']), '1', str(duration)]
    snapshots_received = 0
    child_env = {key: value for key, value in os.environ.items()
                 if key not in SECRET_ENV}
    child_env['EDEN_ENET_NICKNAME'] = nickname
    if timings is not None:
        child_env['EDEN_ENET_TIMINGS'] = '1'
    started = time.monotonic()
    joined = False
    candidate = None
    rejected_snapshot = False
    stopping_after_snapshot = False
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          encoding='ascii', errors='replace', env=child_env) as process:
        last_diagnostic = ''
        watchdog = None
        if hard_timeout is not None:
            watchdog = threading.Timer(hard_timeout, process.kill)
            watchdog.daemon = True
            watchdog.start()
        try:
            for line in process.stdout:
                if timings is not None and line.startswith('EDEN_TIMING '):
                    fields = line.split()
                    if len(fields) == 3:
                        _, phase, milliseconds = fields
                        if phase in ('connect', 'join', 'first_packet') and milliseconds.isdecimal():
                            timings[phase + '_ms'] = int(milliseconds)
                elif line.startswith(nickname + ': '):
                    last_diagnostic = safe_detail(line, 160)
                    if line.strip() == nickname + ': CONECTADO a la sala':
                        joined = True
                elif line.startswith('EDEN_PACKET3 ') and not stopping_after_snapshot:
                    timestamp = datetime.now(timezone.utc).isoformat()
                    try:
                        _, size, encoded = line.strip().split(' ', 2)
                        packet = bytes.fromhex(encoded)
                        if len(packet) != int(size):
                            raise ValueError('Packet length mismatch')
                        snapshot = parse_packet3(packet)
                        players = [p for p in snapshot['jugadores'] if p['nombre'] != nickname]
                        if len(players) > 32:
                            raise ValueError('API supports at most 32 players')
                        candidate = dict(sala_id=room['id'], consultado_en=timestamp, jugadores=players)
                        if timings is not None:
                            timings.setdefault('valid_packet_ms', round((time.monotonic() - started) * 1000))
                    except ValueError as error:
                        rejected_snapshot = True
                        print(f"Rejected snapshot for {room['id']}: {error}", file=sys.stderr)
                if joined and candidate is not None and not stopping_after_snapshot:
                    if first_snapshot:
                        # SIGTERM lets the client exchange the ENet disconnect before exit.
                        process.terminate()
                        stopping_after_snapshot = True
                    else:
                        emit(candidate)
                        snapshots_received += 1
                        candidate = None
            status = process.wait()
            if status != 0:
                detail = last_diagnostic if status > 0 else f'terminated by signal {-status}'
                error_type = RoomUnavailable if status == 1 else ClientError
                raise error_type(f'ENet client exited with status {status}: {detail or "no diagnostic"}')
            if first_snapshot and joined and candidate is not None:
                emit(candidate)
                snapshots_received += 1
            if not snapshots_received:
                if rejected_snapshot:
                    raise ClientError('No compatible snapshot could be decoded')
                raise RoomUnavailable('No valid snapshots received')
        finally:
            if timings is not None:
                timings['collect_ms'] = round((time.monotonic() - started) * 1000)
            if watchdog is not None:
                watchdog.cancel()
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def validate_target(address, port, networks):
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        raise ValueError('Only literal public IPv4 targets are accepted') from None
    if (ip.version != 4 or not ip.is_global or ip.is_multicast or ip.is_reserved
            or str(ip) != address
            or (networks is not None and not any(ip in network for network in networks))):
        raise ValueError('Target is not a permitted public IPv4')
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('Invalid target port')
    return str(ip), port


def scheduled_rooms(base):
    data = api(base, SCHEDULED_PATH, timeout=6)
    if not isinstance(data, dict) or not isinstance(data.get('salas'), list):
        raise ApiError('Invalid scheduled room list')

    expected_storage = SCHEDULED_TARGETS[base][2]
    if data.get('storage') != expected_storage:
        raise ApiError(f'Scheduled API did not confirm the {expected_storage} contract')
    rooms = {}
    for room in data['salas']:
        if not isinstance(room, dict) or room.get('hasPassword') is not False:
            continue
        try:
            address, port = validate_target(room.get('direccion'), room.get('puerto'), None)
        except ValueError:
            continue
        room_id = f"lobby-{address.replace('.', '-')}-{port}"
        if room.get('id') == room_id:
            rooms[room_id] = room

    return rooms


def reserve_production(slot):
    reservation = api(PRODUCTION_URL, SCHEDULED_PATH + '?reserve', {'slot': slot}, timeout=6)
    if not isinstance(reservation, dict) or reservation.get('reserved') is not True:
        raise ApiError('Production slot reservation not acknowledged')


def publish_scheduled(base, snapshot, slot):
    if base == PRODUCTION_URL:
        snapshot = {**snapshot, 'slot': slot}
    result = api(base, SCHEDULED_PATH, snapshot, timeout=6)
    if not isinstance(result, dict) or result.get('ok') is not True:
        raise ApiError('Scheduled snapshot storage not acknowledged')


VERSION_MODULE_ROOT = Path(__file__).resolve().parents[2]
CHECK_PUBLIC_VERSIONS = """
import { readFileSync } from 'node:fs';
import { knownVersion } from './assets/player-versions.js';
const rooms = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(rooms.map(versions => versions.some(knownVersion))));
"""


def public_observations(snapshots, excluded_nickname=DEFAULT_EXCLUDED_NICKNAME):
    players_by_room = [
        [
            {key: player[key] for key in ('nombre', 'juego', 'version', 'virtual_ip', 'title_id') if key in player}
            for player in snapshot['jugadores']
            if player.get('nombre') and player['nombre'] not in ('EdenRoomsConsulta', DEFAULT_EXCLUDED_NICKNAME, excluded_nickname)
        ]
        for snapshot in snapshots
    ]
    if not any(players_by_room):
        return []
    versions_by_room = [[player.get('version') for player in players] for players in players_by_room]
    # Use the same predicate as the site, including the JavaScript engine's Unicode data.
    try:
        result = subprocess.run(
            ['node', '--input-type=module', '-e', CHECK_PUBLIC_VERSIONS],
            cwd=VERSION_MODULE_ROOT, env={'PATH': os.environ.get('PATH', os.defpath)},
            input=json.dumps(versions_by_room), text=True, capture_output=True, check=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        raise ApiError('Could not verify public observation versions with Node.js') from None
    return [
        dict(sala_id=snapshot['sala_id'], consultado_en=snapshot['consultado_en'], jugadores=players)
        for snapshot, players, known in zip(snapshots, players_by_room, json.loads(result.stdout), strict=True)
        if known
    ]


def public_observation(snapshot, excluded_nickname=DEFAULT_EXCLUDED_NICKNAME):
    return next(iter(public_observations([snapshot], excluded_nickname)), None)


def replay_public_observations(filename, slot):
    with open(filename, encoding='utf-8') as source:
        snapshots = json.load(source)
    rooms = scheduled_rooms(PRODUCTION_URL)
    reserve_production(slot)

    def publish(snapshot):
        try:
            publish_scheduled(PRODUCTION_URL, snapshot, slot)
            return True
        except ApiError as error:
            print(f'Production publication failed: {safe_detail(error)}', file=sys.stderr)
            return False

    observations = public_observations([snapshot for snapshot in snapshots if snapshot['sala_id'] in rooms])
    eligible = {observation['sala_id']: observation for observation in observations}
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(publish, sorted(eligible.values(), key=lambda sample: sample['consultado_en'])))
    print(f'Published: {sum(results)}/{len(eligible)}', flush=True)
    return int(not all(results))


def collect_public_rooms(base, binary, slot=None, export=None, *, excluded_nickname=DEFAULT_EXCLUDED_NICKNAME):
    rooms = scheduled_rooms(base)
    if base == PRODUCTION_URL:
        reserve_production(slot)

    def publish(snapshot):
        try:
            publish_scheduled(base, snapshot, slot)
            return 'published'
        except ApiError as error:
            print(f"Publication failed for {snapshot['sala_id']}: {safe_detail(error)}", file=sys.stderr)
            return 'publication_error'

    def sample(room, nickname):
        snapshots = []
        try:
            collect(binary, room, 5, snapshots.append, nickname,
                    hard_timeout=7, first_snapshot=True)
            return snapshots[0] if snapshots else 'unavailable'
        except RoomUnavailable as error:
            print(f"Room unavailable {room['id']}: {safe_detail(error)}", file=sys.stderr)
            return 'unavailable'
        except (ClientError, OSError) as error:
            print(f"ENet client error for {room['id']}: {safe_detail(error)}", file=sys.stderr)
            return 'client_error'

    pipeline = export is not None or base == PRODUCTION_URL
    workers = 8 if pipeline else 2

    def sample_and_queue(room, nickname):
        snapshot = sample(room, nickname)
        if isinstance(snapshot, str):
            return snapshot, None
        status = publication.submit(publish, snapshot) if publication is not None else publish(snapshot)
        return status, snapshot if export is not None else None

    print(f'Eligible rooms: {len(rooms)}', flush=True)
    with (ThreadPoolExecutor(max_workers=workers) if pipeline else nullcontext()) as publication:
        with ThreadPoolExecutor(max_workers=workers) as sampling:
            # Assign names in room order and free each ENet worker before waiting for HTTP.
            results = list(sampling.map(sample_and_queue, rooms.values(), cycle(COLLECTOR_NICKNAMES)))
        if export is not None:
            observations = public_observations([snapshot for _, snapshot in results if snapshot is not None],
                                               excluded_nickname)
            with open(export, 'x', encoding='utf-8') as destination:
                json.dump(observations, destination)
        outcomes = [status if isinstance(status, str) else status.result() for status, _ in results]
    published = outcomes.count('published')
    publication_errors = outcomes.count('publication_error')
    client_errors = outcomes.count('client_error')
    print(f'Published: {published}/{len(rooms)}', flush=True)
    print(f"Unavailable rooms: {outcomes.count('unavailable')}; "
          f'publication errors: {publication_errors}; client errors: {client_errors}', flush=True)
    return int(bool(publication_errors or client_errors))


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
    send_mode.add_argument('--scheduled', action='store_true', help='Sample and publish the public lobby once')
    send_mode.add_argument('--validate-send', action='store_true', help='POST snapshots to validation-only route, without D1 writes')
    handoff = parser.add_mutually_exclusive_group()
    handoff.add_argument('--export-observations', help='Save public observations for the production job')
    handoff.add_argument('--replay-observations', help='Publish public observations without connecting to ENet')
    parser.add_argument('--slot', type=int, help='UTC epoch milliseconds for a production scheduled run')
    parser.add_argument('--room-id', help='Query only this exact registered room ID')
    parser.add_argument('--nickname', default=os.environ.get('EDEN_ENET_NICKNAME'),
                        help='Use a fixed nickname for manual collection instead of rotating')
    args = parser.parse_args()
    if sum((args.check_api, args.check_auth, args.send, args.validate_send, args.scheduled)) > 1:
        parser.error("Choose only one check or publication mode")
    if args.room_id is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", args.room_id):
        parser.error("--room-id must be one nonempty registered room ID")
    if args.nickname is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,24}", args.nickname):
        parser.error("Nickname must contain 1-24 letters, digits, underscores or hyphens")
    base = args.base_url.rstrip('/')
    url = urlsplit(base)
    if url.scheme != 'https' or not url.netloc or url.username or url.query or url.fragment:
        parser.error('A clean HTTPS base URL is required')
    if not 1 <= args.duration <= 600 or args.interval < 1:
        parser.error('Invalid duration/interval')
    if args.scheduled and args.room_id is not None:
        parser.error('--scheduled always processes the public lobby')
    if args.scheduled and base not in SCHEDULED_TARGETS:
        parser.error('--scheduled requires a canonical Preview or production URL')
    production_schedule = args.scheduled and base == PRODUCTION_URL
    if args.export_observations and not (args.scheduled and base == PREVIEW_URL):
        parser.error('--export-observations requires scheduled Preview collection')
    excluded_nickname = os.environ.get('EDEN_ENET_PREVIEW_EXCLUDED_NICKNAME') or DEFAULT_EXCLUDED_NICKNAME
    if args.replay_observations and not production_schedule:
        parser.error('--replay-observations requires scheduled production publication')
    if production_schedule and (not args.slot or args.slot < 0 or args.slot % 300000):
        parser.error('Production collection requires a valid five-minute --slot')
    if args.slot is not None and not production_schedule:
        parser.error('--slot is only used for production collection')
    key_name = SCHEDULED_TARGETS[base][0] if args.scheduled else (
        PREVIEW_KEY if args.check_auth and PREVIEW_KEY in os.environ else 'VERSIONES_API_KEY'
    )
    if (args.send or args.validate_send or args.check_auth or args.scheduled) and not os.environ.get(key_name):
        parser.error(f'{key_name} is required for publishing or checking versions')
    if args.scheduled:
        try:
            if args.replay_observations:
                return replay_public_observations(args.replay_observations, args.slot)
            return collect_public_rooms(base, args.client, args.slot, args.export_observations,
                                        excluded_nickname=excluded_nickname)
        except ApiError as error:
            print(safe_detail(error), file=sys.stderr)
            return 1
        except (OSError, ValueError, TypeError, KeyError):
            print('Invalid or inaccessible scheduled observations', file=sys.stderr)
            return 1
    publisher = SnapshotPublisher(base, validate_only=args.validate_send)
    nicknames = cycle(COLLECTOR_NICKNAMES)
    while True:
        failed = False
        try:
            if args.check_auth:
                result = api(base, VALIDATE_PATH)
                if (not isinstance(result, dict) or result.get('endpoint') != 'versiones-validar'
                    or result.get('contrato') != 1 or result.get('modo') != 'autenticacion'
                    or result.get('autenticado') is not True or result.get('escritura') is not False):
                    raise ApiError('Authentication endpoint did not confirm the no-write contract; refusing fallback')
                print(json.dumps({
                    'ok': True, 'endpoint': 'versiones-validar', 'contrato': 1,
                    'modo': 'autenticacion', 'autenticado': True, 'escritura': False,
                    'db_configurada': result.get('db_configurada') is True,
                }), flush=True)
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
                    collect(args.client, room, args.duration, emit, args.nickname or next(nicknames))
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
