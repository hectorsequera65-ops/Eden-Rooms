"""HTTP client regression tests; all responses mocked, no public network IO."""
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend/enet'))
from collector import ApiError, NoRedirect, USER_AGENT, api, main

class CollectorHTTPTests(unittest.TestCase):
    def response(self, payload):
        result=MagicMock()
        result.__enter__.return_value=io.BytesIO(json.dumps(payload).encode())
        return result

    def test_identifies_application_on_get_and_post_with_separate_keys(self):
        opener=MagicMock()
        opener.open.side_effect=[self.response({'salas':[]}),self.response({'ok':True})]
        with patch.dict(os.environ,{'AUTORIZACIONES_API_KEY':'read-secret','VERSIONES_API_KEY':'write-secret'}), patch('collector.urllib.request.build_opener',return_value=opener):
            self.assertEqual(api('https://example.test','/api/autorizaciones'),{'salas':[]})
            api('https://example.test','/api/versiones-multiples',{'jugadores':[]})
        get,post=[call.args[0] for call in opener.open.call_args_list]
        for request in (get,post):
            self.assertEqual(request.get_header('User-agent'),USER_AGENT)
            self.assertNotIn('Mozilla',USER_AGENT)
        self.assertEqual(get.get_header('X-collector-key'),'read-secret')
        self.assertIsNone(get.get_header('X-api-key'))
        self.assertEqual(post.get_header('X-api-key'),'write-secret')
        self.assertIsNone(post.get_header('X-collector-key'))

    def test_cloudflare_403_has_reason_ray_and_sanitized_details(self):
        body=b'<html><style>hidden</style><h1>Error 1010: Access denied</h1><p>browser_signature_banned</p><script>secret_script()</script></html>'
        error=HTTPError('https://example.test',403,'Forbidden',{'CF-Ray':'ray-id'},io.BytesIO(body))
        with patch('collector.urllib.request.build_opener') as factory:
            factory.return_value.open.side_effect=error
            with self.assertRaises(ApiError) as caught:
                api('https://example.test','/api/autorizaciones')
        message=str(caught.exception)
        for expected in ('HTTP 403','1010','browser_signature_banned','CF-Ray=ray-id','GET /api/autorizaciones'):
            self.assertIn(expected,message)
        for unwanted in ('<html>','secret_script','hidden'):
            self.assertNotIn(unwanted,message)

    def test_application_error_redacts_keys_and_includes_retry_after(self):
        error=HTTPError('https://example.test',429,'Too Many Requests',{'Retry-After':'60'},io.BytesIO(b'{"error":"write-secret read-secret rate limit"}'))
        with patch.dict(os.environ,{'AUTORIZACIONES_API_KEY':'read-secret','VERSIONES_API_KEY':'write-secret'}), patch('collector.urllib.request.build_opener') as factory:
            factory.return_value.open.side_effect=error
            with self.assertRaises(ApiError) as caught:api('https://example.test','/api/versiones-multiples',{})
        message=str(caught.exception)
        self.assertIn('HTTP 429',message)
        self.assertIn('Retry-After=60',message)
        self.assertIn('rate limit',message)
        self.assertNotIn('read-secret',message)
        self.assertNotIn('write-secret',message)

    def test_error_body_is_bounded_and_redirects_are_refused(self):
        stream=io.BytesIO(b'x'*20000)
        error=HTTPError('https://example.test',302,'Found',{'Location':'https://other.test'},stream)
        with patch('collector.urllib.request.build_opener') as factory:
            factory.return_value.open.side_effect=error
            with self.assertRaises(ApiError) as caught:api('https://example.test','/api/autorizaciones')
        self.assertLess(len(str(caught.exception)),1200)
        self.assertIn('redirect refused',str(caught.exception))
        self.assertIsNone(NoRedirect().redirect_request(None,None,302,'Found',{},'https://other.test'))

    def test_network_reason_and_invalid_json(self):
        with patch('collector.urllib.request.build_opener') as factory:
            factory.return_value.open.side_effect=URLError('TLS certificate verification failed')
            with self.assertRaisesRegex(ApiError,'TLS certificate verification failed'):
                api('https://example.test','/api/autorizaciones')
        response=MagicMock()
        response.__enter__.return_value=io.BytesIO(b'<html>not JSON</html>')
        response.__enter__.return_value.status=200
        with patch('collector.urllib.request.build_opener') as factory:
            factory.return_value.open.return_value=response
            with self.assertRaisesRegex(ApiError,'HTTP 200, invalid JSON'):
                api('https://example.test','/api/autorizaciones')

    def test_check_api_does_not_connect_enet_or_write(self):
        with patch('sys.argv',['collector.py','--base-url','https://example.test','--check-api']), patch('collector.api',return_value={'salas':[{'id':'room'}]}) as fetch, patch('collector.collect') as connect, patch('sys.stdout',new_callable=io.StringIO) as stdout:
            self.assertEqual(main(),0)
            self.assertEqual(json.loads(stdout.getvalue()),{'ok':True,'salas':1})
            fetch.assert_called_once_with('https://example.test','/api/autorizaciones')
            connect.assert_not_called()

    def test_validate_send_uses_only_separate_no_write_route_for_selected_room(self):
        rooms={'salas':[{'id':'eu','autorizada':True,'direccion':'room.test','puerto':6007},{'id':'other','autorizada':True,'direccion':'other.test','puerto':6008}]}
        snapshot={'sala_id':'eu','jugadores':[]}
        def collect_one(binary,room,duration,emit,nickname):
            self.assertEqual(room['id'],'eu')
            emit(snapshot)
        with patch.dict(os.environ,{'VERSIONES_API_KEY':'write-secret'}), patch('sys.argv',['collector.py','--base-url','https://example.test','--validate-send','--once','--room-id','eu']), patch('collector.api',side_effect=[rooms,{'validado':True,'escritura':False}]) as fetch, patch('collector.collect',side_effect=collect_one) as connect, patch('sys.stdout',new_callable=io.StringIO):
            self.assertEqual(main(),0)
            connect.assert_called_once()
            self.assertEqual([call.args[1] for call in fetch.call_args_list],['/api/autorizaciones','/api/versiones-validar'])

    def test_validation_never_falls_back_to_real_write_on_bad_reply(self):
        rooms={'salas':[{'id':'eu','autorizada':True,'direccion':'room.test','puerto':6007}]}
        def collect_one(binary,room,duration,emit,nickname):emit({'sala_id':'eu','jugadores':[]})
        with patch.dict(os.environ,{'VERSIONES_API_KEY':'write-secret'}), patch('sys.argv',['collector.py','--base-url','https://example.test','--validate-send','--once']), patch('collector.api',side_effect=[rooms,{'ok':True}]) as fetch, patch('collector.collect',side_effect=collect_one), patch('sys.stderr',new_callable=io.StringIO) as stderr:
            self.assertEqual(main(),1)
            self.assertIn('refusing fallback',stderr.getvalue())
            self.assertNotIn('/api/versiones-multiples',[call.args[1] for call in fetch.call_args_list])

    def test_missing_selected_room_fails_without_enet(self):
        with patch('sys.argv',['collector.py','--base-url','https://example.test','--room-id','missing','--once']), patch('collector.api',return_value={'salas':[]}), patch('collector.collect') as connect, patch('sys.stderr',new_callable=io.StringIO):
            self.assertEqual(main(),1)
            connect.assert_not_called()

    def test_check_auth_is_a_single_read_only_get_with_no_enet_or_authorization_fetch(self):
        result={'ok':True,'endpoint':'versiones-validar','contrato':1,'modo':'autenticacion','autenticado':True,'escritura':False,'db_configurada':True}
        with patch.dict(os.environ,{'VERSIONES_API_KEY':'write-secret'}), patch('sys.argv',['collector.py','--base-url','https://example.test','--check-auth']), patch('collector.api',return_value=result) as fetch, patch('collector.collect') as connect, patch('sys.stdout',new_callable=io.StringIO) as stdout:
            self.assertEqual(main(),0)
            fetch.assert_called_once_with('https://example.test','/api/versiones-validar')
            connect.assert_not_called()
            self.assertEqual(json.loads(stdout.getvalue()),result)

    def test_check_auth_forwards_only_write_key_and_refuses_old_json_contract(self):
        opener=MagicMock()
        opener.open.return_value=self.response({'ok':True})
        with patch.dict(os.environ,{'VERSIONES_API_KEY':'write-secret','AUTORIZACIONES_API_KEY':'read-secret'}), patch('collector.urllib.request.build_opener',return_value=opener):
            api('https://example.test','/api/versiones-validar')
        request=opener.open.call_args.args[0]
        self.assertEqual(request.get_method(),'GET')
        self.assertEqual(request.get_header('X-api-key'),'write-secret')
        self.assertIsNone(request.get_header('X-collector-key'))
        with patch.dict(os.environ,{'VERSIONES_API_KEY':'write-secret'}), patch('sys.argv',['collector.py','--base-url','https://example.test','--check-auth']), patch('collector.api',return_value={'ok':True}) as fetch, patch('sys.stderr',new_callable=io.StringIO) as stderr:
            self.assertEqual(main(),1)
            fetch.assert_called_once()
            self.assertIn('refusing fallback',stderr.getvalue())

    def test_once_reports_error_and_returns_failure_without_enet(self):
        with patch('sys.argv',['collector.py','--base-url','https://example.test','--once']), patch('collector.api',side_effect=ApiError('HTTP 403; detail=1010 browser_signature_banned')), patch('collector.collect') as connect, patch('sys.stderr',new_callable=io.StringIO) as stderr:
            self.assertEqual(main(),1)
            self.assertIn('HTTP 403',stderr.getvalue())
            self.assertIn('browser_signature_banned',stderr.getvalue())
            connect.assert_not_called()

if __name__=='__main__':unittest.main()
