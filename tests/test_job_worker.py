from datetime import datetime, timezone
import io
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock,patch
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend/enet'))
from job_worker import JobWorker,PREVIEW_URL,parse_allowlist,validate_target
from collector import api,collect,safe_detail

class WorkerTests(unittest.TestCase):
    def job(self):
        return {'job_id':str(uuid.uuid4()),'lease_token':str(uuid.uuid4()),'sala_id':'smash',
                'direccion':'69.24.117.72','puerto':20668,'vence_en':datetime.fromtimestamp(time.time()+30,timezone.utc).isoformat()}

    def test_only_public_literal_allowlisted_targets_and_preview_are_accepted(self):
        networks=parse_allowlist(['69.24.117.72/32'])
        self.assertEqual(validate_target('69.24.117.72',20668,networks),('69.24.117.72',20668))
        for address in ['localhost','room.test','127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','::1','224.0.0.1','2130706433','8.8.8.8']:
            with self.subTest(address=address),self.assertRaises(ValueError):validate_target(address,20668,networks)
        for cidr in [[],['0.0.0.0/0'],['10.0.0.0/24']]:
            with self.assertRaises(ValueError):parse_allowlist(cidr)
        with self.assertRaises(ValueError):JobWorker('https://eden-rooms.pages.dev','unused',networks)

    def test_reuses_collector_with_sralcer_bounded_time_and_returns_latest_packet(self):
        job=self.job();transport=MagicMock(return_value={'ok':True})
        def capture(binary,room,duration,emit,nickname,hard_timeout):
            self.assertEqual(room,{'id':'smash','direccion':'69.24.117.72','puerto':20668})
            self.assertEqual(nickname,'sralcer');self.assertLessEqual(duration,8);self.assertLessEqual(hard_timeout,15)
            emit({'sala_id':'smash','jugadores':[{'nombre':'Eden','version':'13.0.2'}]})
            emit({'sala_id':'smash','jugadores':[{'nombre':'Eden','version':'13.0.5'}]})
        worker=JobWorker(PREVIEW_URL,'unused',parse_allowlist(['69.24.117.72/32']),transport=transport,collector=capture)
        self.assertTrue(worker.run(job))
        request=transport.call_args.args[2]
        self.assertEqual(request['action'],'complete');self.assertEqual(request['snapshot']['jugadores'][0]['version'],'13.0.5')
        self.assertEqual(request['lease_token'],job['lease_token'])

    def test_unsafe_or_expired_jobs_never_launch_enet(self):
        transport=MagicMock(return_value={'ok':True});capture=MagicMock()
        worker=JobWorker(PREVIEW_URL,'unused',parse_allowlist(['69.24.117.72/32']),transport=transport,collector=capture)
        for change in [{'direccion':'127.0.0.1'},{'vence_en':datetime.fromtimestamp(time.time()-1,timezone.utc).isoformat()}]:
            with patch('sys.stderr',new_callable=io.StringIO):self.assertFalse(worker.run({**self.job(),**change}))
        capture.assert_not_called()
        self.assertTrue(all(call.args[2]['action']=='fail' for call in transport.call_args_list))

    def test_private_https_uses_collector_key_only_and_redacts_it(self):
        opener=MagicMock();response=io.BytesIO(b'{"trabajo":null}')
        opener.open.return_value.__enter__.return_value=response
        with patch.dict(os.environ,{'COLLECTOR_API_KEY':'private-secret'},clear=True),patch('collector.urllib.request.build_opener',return_value=opener):
            self.assertEqual(api(PREVIEW_URL,'/api/collector/jobs',{'action':'claim'},timeout=6),{'trabajo':None})
            self.assertNotIn('private-secret',safe_detail('error private-secret'))
        request=opener.open.call_args.args[0]
        self.assertEqual(request.get_header('X-collector-key'),'private-secret');self.assertIsNone(request.get_header('X-api-key'))
        self.assertEqual(opener.open.call_args.kwargs['timeout'],6)

    def test_enet_subprocess_never_inherits_https_secrets(self):
        process=MagicMock();process.stdout=[];process.wait.return_value=0;process.poll.return_value=0
        process.__enter__.return_value=process
        secrets={key:'private-value' for key in ('COLLECTOR_API_KEY','VERSIONES_API_KEY','AUTORIZACIONES_API_KEY')}
        with patch.dict(os.environ,secrets),patch('collector.subprocess.Popen',return_value=process) as launch:
            with self.assertRaises(RuntimeError):collect('unused',{'id':'room','direccion':'69.24.117.72','puerto':20668},1,lambda _:None)
        child=launch.call_args.kwargs['env']
        self.assertTrue(all(key not in child for key in secrets));self.assertEqual(child['EDEN_ENET_NICKNAME'],'sralcer')

    def test_hard_timeout_kills_a_stalled_client_without_publishing_empty_results(self):
        with tempfile.TemporaryDirectory() as directory:
            script=Path(directory)/'stalled-client'
            script.write_text('#!/usr/bin/env python3\nimport time\ntime.sleep(5)\n');script.chmod(0o755)
            emitted=[];started=time.monotonic()
            with self.assertRaises(RuntimeError):collect(str(script),{'id':'room','direccion':'69.24.117.72','puerto':20668},1,emitted.append,hard_timeout=0.2)
            self.assertLess(time.monotonic()-started,2);self.assertEqual(emitted,[])

if __name__=='__main__':unittest.main()
