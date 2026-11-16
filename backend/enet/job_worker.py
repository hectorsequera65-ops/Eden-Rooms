#!/usr/bin/env python3
"""Preview-only outbound HTTPS worker. Does not expose an HTTP listener."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import ipaddress
import os
import re
import signal
import sys
import threading
import time
import uuid
from collector import api, collect, ApiError, safe_detail

PREVIEW_URL='https://test-enet-versions-sralcer.eden-rooms.pages.dev'


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


def validate_target(address,port,networks):
    try:ip=ipaddress.ip_address(address)
    except ValueError:raise ValueError('Only literal public IPv4 targets are accepted') from None
    if (ip.version!=4 or not ip.is_global or ip.is_multicast or ip.is_reserved
            or str(ip)!=address or not any(ip in network for network in networks)):
        raise ValueError('Target is not a public allowlisted IPv4')
    if type(port) is not int or not 1<=port<=65535:
        raise ValueError('Invalid target port')
    return str(ip),port


class JobWorker:
    def __init__(self,base,binary,networks,transport=None,collector=None,now=None):
        if base.rstrip('/')!=PREVIEW_URL:
            raise ValueError('Only the configured Preview URL is supported')
        self.base=base.rstrip('/');self.binary=binary;self.networks=networks
        self.transport=transport or (lambda base,path,data:api(base,path,data,timeout=6))
        self.collector=collector or collect
        self.now=now or time.time

    def request(self,data):return self.transport(self.base,'/api/collector/jobs',data)

    def claim(self):
        result=self.request({'action':'claim'})
        if not isinstance(result,dict) or 'trabajo' not in result:
            raise ApiError('Invalid job response')
        return result['trabajo']

    def run(self,job):
        identity={}
        try:
            if not isinstance(job,dict):raise ValueError('Invalid job')
            for key in ('job_id','lease_token'):
                value=job.get(key,'')
                if not isinstance(value,str) or str(uuid.UUID(value))!=value.lower():raise ValueError('Invalid job identity')
            identity={'job_id':job['job_id'],'lease_token':job['lease_token']}
            if not isinstance(job.get('sala_id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',job['sala_id']):
                raise ValueError('Invalid room ID')
            address,port=validate_target(job.get('direccion'),job.get('puerto'),self.networks)
            deadline=datetime.fromisoformat(job['vence_en'].replace('Z','+00:00'))
            if deadline.tzinfo is None:raise ValueError('Deadline must have timezone')
            remaining=deadline.timestamp()-self.now()
            if remaining<10 or remaining>35:raise ValueError('Job lease is expired or invalid')
            hard_timeout=min(15,remaining-8)
            duration=max(1,min(8,int(hard_timeout)-2))
            snapshots=[]
            self.collector(self.binary,{'id':job['sala_id'],'direccion':address,'puerto':port},duration,
                           snapshots.append,'sralcer',hard_timeout=hard_timeout)
            if not snapshots:raise ValueError('No valid ENet snapshot')
            if self.now()>=deadline.timestamp()-1:raise ValueError('Job expired before completion')
            result=self.request({'action':'complete',**identity,'snapshot':snapshots[-1]})
            if not isinstance(result,dict) or result.get('ok') is not True:raise ApiError('Completion not acknowledged')
            return True
        except Exception as error:
            print(f'ENet job failed: {type(error).__name__}: {safe_detail(error)}',file=sys.stderr)
            if identity:
                try:self.request({'action':'fail',**identity})
                except Exception:pass # Expired leases are cleaned up server-side.
            return False


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default=PREVIEW_URL)
    parser.add_argument('--client',default='/opt/eden-rooms-enet/eden-collector')
    parser.add_argument('--workers',type=int,choices=(1,2),default=2)
    parser.add_argument('--poll-seconds',type=float,default=3)
    parser.add_argument('--allow-cidr',action='append',default=[])
    parser.add_argument('--once',action='store_true',help='Claim and process at most one job, then exit')
    args=parser.parse_args()
    if not os.environ.get('COLLECTOR_API_KEY'):parser.error('COLLECTOR_API_KEY is required')
    if not 2<=args.poll_seconds<=30:parser.error('Poll interval must be 2–30 seconds')
    try:
        networks=parse_allowlist(args.allow_cidr+[s for s in os.environ.get('ENET_ALLOWED_CIDRS','').split(',') if s.strip()])
        worker=JobWorker(args.base_url,args.client,networks)
    except ValueError as error:parser.error(str(error))
    if args.once:
        try:
            job=worker.claim()
            return int(not worker.run(job)) if job else 0
        except Exception as error:
            print(f'Job poll failed: {safe_detail(error)}',file=sys.stderr);return 1
    stop=threading.Event()
    signal.signal(signal.SIGTERM,lambda *_:stop.set())
    signal.signal(signal.SIGINT,lambda *_:stop.set())
    failures=0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        active=set()
        while not stop.is_set():
            active={future for future in active if not future.done()}
            if len(active)>=args.workers:
                stop.wait(0.5);continue
            try:
                job=worker.claim();failures=0
                if job:active.add(pool.submit(worker.run,job))
                else:stop.wait(args.poll_seconds)
            except Exception as error:
                failures+=1
                print(f'Job poll failed: {safe_detail(error)}',file=sys.stderr)
                stop.wait(min(30,args.poll_seconds*2**min(failures,3)))
    return 0

if __name__=='__main__':raise SystemExit(main())
