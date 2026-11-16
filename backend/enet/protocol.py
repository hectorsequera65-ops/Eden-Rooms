"""Length-delimited Eden packet 3; only player text fields require UTF-8."""
import ipaddress


class Reader:
    def __init__(self, data):
        self.data, self.offset = data, 0

    def take(self, size, field='field'):
        if size < 0 or self.offset + size > len(self.data):
            raise ValueError(f'{field}: truncated packet at offset {self.offset}')
        result = self.data[self.offset:self.offset + size]
        self.offset += size
        return result

    def integer(self, size=4, field='integer'):
        return int.from_bytes(self.take(size, field), 'big')

    def blob(self, limit=4096, field='blob'):
        size = self.integer(field=field + '.length')
        if size > limit:
            raise ValueError(f'{field}: oversized field ({size} bytes) at offset {self.offset - 4}')
        return self.take(size, field)

    def string(self, limit=4096, field='text'):
        raw = self.blob(limit, field)
        start = self.offset - len(raw)
        try:
            return raw.decode('utf-8')
        except UnicodeDecodeError as error:
            # Never replace bytes in an identity/game/version used for enrichment.
            raise ValueError(f'{field}: invalid UTF-8 at packet offset {start + error.start}') from error

    def ipv4(self, field):
        # Four raw octets, with no length prefix and no text decoding.
        return str(ipaddress.IPv4Address(self.take(4, field)))


def parse_packet3(data):
    r = Reader(data)
    if r.integer(1, 'packet.id') != 3:
        raise ValueError('Not packet 3')
    # Header labels are not identities and never used to match players/rooms.
    # C++ Packet strings are length-delimited bytes, not guaranteed UTF-8.
    # Keep the original bytes until the entire binary structure is consumed.
    name = r.blob(field='room.name')
    description = r.blob(field='room.description')
    maximum = r.integer(field='room.max_players')
    port = r.integer(2, 'room.port')
    preferred = r.blob(field='room.preferred_game')
    owner = r.blob(field='room.owner')
    count = r.integer(field='room.member_count')
    if count > 256:
        raise ValueError('Too many members')
    players = []
    for index in range(count):
        field = f'players[{index}]'
        nickname = r.string(80, field + '.nickname')
        address = r.ipv4(field + '.virtual_ip')
        game = r.string(160, field + '.game')
        title_id = f'{r.integer(8, field + ".title_id"):016X}'
        version = r.string(40, field + '.version')
        # Account metadata can be nonempty; consume each length and its payload.
        # It is not needed for identity matching or the public versions snapshot.
        for key in ('username', 'display_name', 'avatar_url'):
            r.blob(field=field + '.' + key)
        players.append(dict(nombre=nickname, virtual_ip=address, juego=game,
                            title_id=title_id, version=version))
    if r.offset != len(data):
        raise ValueError(f'Unexpected packet tail/layout at offset {r.offset}')
    if len({p['virtual_ip'] for p in players}) != count:
        raise ValueError('Duplicate virtual IP in snapshot')
    # Display-only header values escape undecodable bytes, preserving evidence.
    # They are deliberately excluded from collector uploads; no lossy nicknames.
    return dict(sala=name.decode('utf-8', errors='backslashreplace'),
                description=description.decode('utf-8', errors='backslashreplace'),
                max_players=maximum, port=port,
                preferred_game=preferred.decode('utf-8', errors='backslashreplace'),
                owner=owner.decode('utf-8', errors='backslashreplace'), jugadores=players)
