#!/usr/bin/env python3
"""Preview-only outbound HTTPS worker. Does not expose an HTTP listener."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from functools import partial
import ipaddress
import os
import re
import signal
import sys
import threading
import time
import uuid
from collector import api, collect, ApiError, safe_detail, validate_target

PREVIEW_URL='https://test-enet-versions-sralcer.eden-rooms.pages.dev'
SNAPSHOT_CACHE_SECONDS = 2
SNAPSHOT_CACHE_SIZE = 32


def parse_allowlist(values):
    networks=[]
    for value in values:
        network=ipaddress.ip_network(value.strip(),strict=True)
        if (network.version!=4 or network.prefixlen<24 or not network.network_address.is_global
                or network.network_address.is_multicast or not network.broadcast_address.is_global):
            raise ValueError('Allowlist requires public IPv4 /24 through /32 networks')
        networks.append(network)
    if not networks:
        raise ValueError('Configure at least one authorized public IPv4 /32')
    return networks


class JobWorker:
    def __init__(self,base,binary,networks,transport=None,collector=None,now=None):
        if base.rstrip('/')!=PREVIEW_URL:
            raise ValueError('Only the configured Preview URL is supported')
        self.base=base.rstrip('/');self.binary=binary;self.networks=networks
        self.transport=transport or (lambda base,path,data:api(base,path,data,timeout=6))
        self.collector = collector or partial(collect, first_snapshot=True)
        self.collector_reports_timings = collector is None
        self.now=now or time.time
        self.targets = set()
        self.snapshots = {}
        self.target_changed = threading.Condition()

    def request(self,data):return self.transport(self.base,'/api/collector/jobs',data)

    def claim(self):
        result=self.request({'action':'claim'})
        if not isinstance(result,dict) or 'trabajo' not in result:
            raise ApiError('Invalid job response')
        return result['trabajo']

    def run(self,job):
        identity={}
        target = None
        timings = {}
        started = time.monotonic()
        try:
            if not isinstance(job,dict):raise ValueError('Invalid job')
            for key in ('job_id','lease_token'):
                value=job.get(key,'')
                if not isinstance(value,str) or str(uuid.UUID(value))!=value.lower():raise ValueError('Invalid job identity')
            identity={'job_id':job['job_id'],'lease_token':job['lease_token']}
            if not isinstance(job.get('sala_id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',job['sala_id']):
                raise ValueError('Invalid room ID')
            # Preview rechecks lobby membership when leasing a lobby job.
            networks=None if job['sala_id'].startswith('lobby-') else self.networks
            address,port=validate_target(job.get('direccion'),job.get('puerto'),networks)
            if networks is None and job['sala_id']!=f"lobby-{address.replace('.', '-')}-{port}":
                raise ValueError('Room ID does not match target')
            deadline=datetime.fromisoformat(job['vence_en'].replace('Z','+00:00'))
            if deadline.tzinfo is None:raise ValueError('Deadline must have timezone')
            remaining=deadline.timestamp()-self.now()
            if remaining<10 or remaining>35:raise ValueError('Job lease is expired or invalid')
            # Aliases can refer to the same room. Keep the fixed nickname
            # exclusive to one ENet connection per endpoint on this worker.
            with self.target_changed:
                endpoint = (address, port)
                if not self.target_changed.wait_for(
                    lambda: endpoint not in self.targets, timeout=max(0, remaining - 10)
                ):
                    raise ValueError('Another job is still sampling this endpoint')
                target = endpoint
                self.targets.add(target)
            remaining = deadline.timestamp() - self.now()
            if remaining < 10:
                raise ValueError('Insufficient lease time after waiting for endpoint')
            hard_timeout = min(7, remaining - 7)
            duration = min(5, int(hard_timeout) - 2)
            room = {'id': job['sala_id'], 'direccion': address, 'puerto': port}
            enet_started = time.monotonic()
            timings['dispatch_ms'] = round((enet_started - started) * 1000)
            try:
                snapshot = self.sample(room, target, duration, hard_timeout, timings)
            finally:
                self.release_target(target)
                target = None
            if snapshot is None:raise ValueError('No valid ENet snapshot')
            if self.now()>=deadline.timestamp()-1:raise ValueError('Job expired before completion')
            completing = time.monotonic()
            try:
                result=self.request({'action':'complete',**identity,'snapshot':snapshot})
            finally:
                timings['complete_ms'] = round((time.monotonic() - completing) * 1000)
            if not isinstance(result,dict) or result.get('ok') is not True:raise ApiError('Completion not acknowledged')
            return True
        except Exception as error:
            print(f'ENet job failed: {type(error).__name__}: {safe_detail(error)}',file=sys.stderr)
            if identity:
                try:self.request({'action':'fail',**identity})
                except Exception as failure:
                    print(f'Could not report ENet job failure: {safe_detail(failure)}',file=sys.stderr)
            return False
        finally:
            if target is not None:
                self.release_target(target)
            if identity:
                timings['job_ms'] = round((time.monotonic() - started) * 1000)
                fields = ' '.join(f'{key}={value}' for key, value in timings.items())
                print(f"ENet job timing id={identity['job_id']} {fields}", flush=True)

    def sample(self, room, target, duration, hard_timeout, timings):
        with self.target_changed:
            cached = self.snapshots.get(target)
            if cached and time.monotonic() - cached[0] < SNAPSHOT_CACHE_SECONDS:
                timings['cache_hit'] = 1
                return dict(cached[1], sala_id=room['id'])

        sample = None
        received = None

        def keep_latest(snapshot):
            nonlocal sample, received
            sample = snapshot
            received = time.monotonic()

        started = time.monotonic()
        try:
            options = {'timings': timings} if self.collector_reports_timings else {}
            self.collector(self.binary, room, duration, keep_latest, 'sralcer',
                           hard_timeout=hard_timeout, **options)
        finally:
            timings.setdefault('collect_ms', round((time.monotonic() - started) * 1000))
        if sample is not None:
            # A second request can reuse this successful sample without
            # reconnecting during the room's join rate limit.
            with self.target_changed:
                self.snapshots.pop(target, None)
                self.snapshots[target] = (received, sample)
                if len(self.snapshots) > SNAPSHOT_CACHE_SIZE:
                    del self.snapshots[next(iter(self.snapshots))]
        return sample

    def release_target(self, target):
        with self.target_changed:
            self.targets.remove(target)
            self.target_changed.notify_all()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default=PREVIEW_URL)
    parser.add_argument('--client',default='/opt/eden-rooms-enet/eden-collector')
    parser.add_argument('--workers',type=int,choices=(1,2),default=2)
    parser.add_argument('--poll-seconds',type=float,default=2)
    parser.add_argument('--allow-cidr',action='append',default=[])
    parser.add_argument('--once',action='store_true',help='Claim and process at most one job, then exit')
    args=parser.parse_args()
    if not os.environ.get('COLLECTOR_API_KEY'):parser.error('COLLECTOR_API_KEY is required')
    if not 2<=args.poll_seconds<=30:parser.error('Poll interval must be 2–30 seconds')
    try:
        cidrs=args.allow_cidr+[s for s in os.environ.get('ENET_ALLOWED_CIDRS','').split(',') if s.strip()]
        networks=parse_allowlist(cidrs) if cidrs else []
        worker=JobWorker(args.base_url,args.client,networks)
    except ValueError as error:parser.error(str(error))
    if args.once:
        try:
            job=worker.claim()
            return int(not worker.run(job)) if job else 0
        except Exception as error:
            print(f'Job poll failed: {safe_detail(error)}',file=sys.stderr);return 1
    stop = threading.Event()
    wake = threading.Event()

    def shutdown(*_):
        stop.set()
        wake.set()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    failures = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        active = set()
        while not stop.is_set():
            wake.clear()
            if stop.is_set():
                break
            active = {future for future in active if not future.done()}
            if len(active) >= args.workers:
                wake.wait()
                continue
            try:
                claim_started = time.monotonic()
                job = worker.claim()
                failures = 0
                if job:
                    claim_ms = round((time.monotonic() - claim_started) * 1000)
                    print(f'ENet claim timing claim_ms={claim_ms}', flush=True)
                    future = pool.submit(worker.run, job)
                    active.add(future)
                    future.add_done_callback(lambda _: wake.set())
                else:
                    wake.wait(args.poll_seconds)
            except Exception as error:
                failures += 1
                print(f'Job poll failed: {safe_detail(error)}', file=sys.stderr)
                stop.wait(min(30, args.poll_seconds * 2**min(failures, 3)))
    return 0

if __name__=='__main__':raise SystemExit(main())
