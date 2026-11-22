// Local-only ENet fixture server: validates join bytes and returns supplied packet 3.
#include <enet/enet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
int main(int argc, char **argv) {
    assert(argc == 2 || argc == 3);
    int mismatch = argc == 3 && strcmp(argv[2], "mismatch") == 0;
    FILE *input = fopen(argv[1], "r"); assert(input);
    unsigned char data[65536]; size_t length=0; unsigned value;
    while (fscanf(input, "%2x", &value)==1) { assert(length<sizeof(data)); data[length++]=(unsigned char)value; }
    fclose(input);
    assert(enet_initialize()==0);
    ENetAddress address={0}; address.port=0;
    assert(enet_address_set_host_ip(&address,"127.0.0.1")==0);
    ENetHost *server=enet_host_create(&address,1,1,0,0); assert(server);
    ENetAddress actual; assert(enet_socket_get_address(server->socket,&actual)==0);
    printf("%u\n",actual.port);fflush(stdout);
    int joined=0;
    enet_uint32 start=enet_time_get();
    while (enet_time_get()-start<6000) {
        ENetEvent event;
        if(enet_host_service(server,&event,50)<=0)continue;
        if(event.type==ENET_EVENT_TYPE_RECEIVE) {
            const unsigned char expected[]={1,0,0,0,7,'s','r','a','l','c','e','r',255,255,255,255,0,0,0,1,0,0,0,0,0,0,0,0};
            assert(!joined); // no game announcement or chat allowed
            assert(event.channelID==0);
            assert(event.packet->dataLength==sizeof(expected));
            assert(memcmp(event.packet->data,expected,sizeof(expected))==0);
            // Eden can send room information before confirming the join.
            enet_peer_send(event.peer, 0, enet_packet_create(data, length, ENET_PACKET_FLAG_RELIABLE));
            if (mismatch) {
                const unsigned char reject[] = {10, 0, 0, 1, 2};
                enet_peer_send(event.peer, 0, enet_packet_create(reject, sizeof(reject), ENET_PACKET_FLAG_RELIABLE));
            } else {
                const unsigned char ok[] = {2, 10, 0, 0, 1};
                enet_peer_send(event.peer, 0, enet_packet_create(ok, sizeof(ok), ENET_PACKET_FLAG_RELIABLE));
            }
            enet_host_flush(server);joined=1;
            enet_packet_destroy(event.packet);
        }
        if(event.type==ENET_EVENT_TYPE_DISCONNECT)break;
    }
    enet_host_destroy(server);enet_deinitialize();return joined?0:1;
}
