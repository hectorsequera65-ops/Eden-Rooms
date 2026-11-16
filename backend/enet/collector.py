#!/usr/bin/env python3
"""Ubuntu ENet collector. Sending requires --send; otherwise prints snapshots."""
import argparse
from datetime import datetime, timezone
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit
from protocol import parse_packet3


def api(base, path, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    headers = {'Accept': 'application/json'}
    if body is not None:
        headers.update({'Content-Type': 'application/json',
                        'X-API-Key': os.environ['VERSIONES_API_KEY']})
    req = urllib.request.Request(base + path, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)


def collect(binary, room, duration, emit, nickname="sralcer"):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,24}", nickname):
        raise ValueError("Invalid collector nickname")
    # No shell expansion; one ENet peer; never announce an invented game.
    command = [binary, room['direccion'], str(room['puerto']), '1', str(duration)]
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          text=True, env={**os.environ, 'EDEN_ENET_NICKNAME': nickname}) as process:
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
                except (ValueError, UnicodeError) as error:
                    print(f"Rejected snapshot for {room['id']}: {error}", file=sys.stderr)
            if process.wait() != 0:
                raise RuntimeError('ENet client failed; no empty snapshot sent')
        finally:
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
    parser.add_argument('--send', action='store_true')
    parser.add_argument('--nickname', default=os.environ.get('EDEN_ENET_NICKNAME', 'sralcer'))
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,24}", args.nickname):
        parser.error("Nickname must contain 1-24 letters, digits, underscores or hyphens")
    base = args.base_url.rstrip('/')
    url = urlsplit(base)
    if url.scheme != 'https' or not url.netloc or url.username or url.query or url.fragment:
        parser.error('A clean HTTPS base URL is required')
    if not 1 <= args.duration <= 600 or args.interval < 1:
        parser.error('Invalid duration/interval')
    if args.send and not os.environ.get('VERSIONES_API_KEY'):
        parser.error('VERSIONES_API_KEY is required for --send')
    while True:
        try:
            rooms = api(base, '/api/autorizaciones')['salas']
            for room in rooms:
                if not room.get('autorizada') or not room.get('direccion') or not room.get('puerto'):
                    continue
                try:
                    def emit(snapshot):
                        if args.send:
                            api(base, '/api/versiones-multiples', snapshot)
                        else:
                            print(json.dumps(snapshot, ensure_ascii=False), flush=True)
                    collect(args.client, room, args.duration, emit, args.nickname)
                except Exception as error:
                    print(f"Collection failed for {room['id']}: {type(error).__name__}", file=sys.stderr)
        except Exception as error:
            print(f'Authorization fetch failed: {type(error).__name__}', file=sys.stderr)
        if args.once:
            break
        time.sleep(args.interval)


if __name__ == '__main__':
    main()
