#!/usr/bin/env python3
"""Decode complete captured packet-3 snapshots offline, without any network IO."""
import argparse
import json
import sys
from protocol import parse_packet3

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('log',nargs='?',type=argparse.FileType('r'),default=sys.stdin)
    args=parser.parse_args()
    failed=False
    for line_number,line in enumerate(args.log,1):
        if not line.startswith('EDEN_PACKET3 '):continue
        try:
            _,size,encoded=line.strip().split(' ',2)
            if len(encoded)>131072:raise ValueError('Packet too large')
            packet=bytes.fromhex(encoded)
            if len(packet)!=int(size):raise ValueError('Size mismatch')
            print(json.dumps(dict(line=line_number,**parse_packet3(packet)),ensure_ascii=False))
        except (ValueError,UnicodeError) as error:
            failed=True
            print(f'Line {line_number}: {error}',file=sys.stderr)
    return int(failed)

if __name__=='__main__':raise SystemExit(main())
