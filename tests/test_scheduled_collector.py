"""Scheduled collection uses fixture targets and mocked HTTPS and ENet."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend/enet'))
from collector import ApiError, SCHEDULED_PATH, collect_public_rooms


class ScheduledCollectorTest(unittest.TestCase):
    def test_filters_targets_and_publishes_successes_despite_a_failed_room(self):
        def room(address, port=20668, protected=False):
            return dict(id=f"lobby-{address.replace('.', '-')}-{port}",
                        direccion=address, puerto=port, hasPassword=protected)

        first, second = room('8.8.8.8'), room('1.1.1.1')
        rooms = [first, first, second, room('9.9.9.9', protected=True),
                 room('127.0.0.1'), room('8.8.4.4', port=0),
                 dict(room('8.8.4.4'), id='wrong'), room('8.8.4.4', protected=None)]

        def transport(base, path, snapshot=None, *, timeout):
            self.assertEqual((base, path, timeout), ('https://example.test', SCHEDULED_PATH, 6))
            if snapshot is None:
                return {'salas': rooms}
            self.assertEqual(snapshot, {'sala_id': second['id'], 'jugadores': []})
            return {'ok': True}

        def collect(binary, target, duration, emit, nickname, **options):
            self.assertEqual((binary, duration, nickname), ('fixture', 5, 'EdenVersions'))
            self.assertEqual(options, {'hard_timeout': 7, 'first_snapshot': True})
            if target == first:
                raise RuntimeError('fixture timeout')
            emit({'sala_id': target['id'], 'jugadores': []})

        with patch('collector.api', side_effect=transport) as http, \
                patch('collector.collect', side_effect=collect) as enet:
            self.assertEqual(collect_public_rooms('https://example.test', 'fixture'), 1)
            self.assertCountEqual([call.args[1] for call in enet.call_args_list], [first, second])
            self.assertEqual(http.call_count, 2)

    def test_invalid_list_never_connects(self):
        with patch('collector.api', return_value={}), patch('collector.collect') as enet:
            with self.assertRaises(ApiError):
                collect_public_rooms('https://example.test', 'fixture')
            enet.assert_not_called()
