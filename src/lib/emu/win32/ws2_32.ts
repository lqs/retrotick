import type { Emulator } from '../emulator';

const WSADESCRIPTION_LEN = 256;
const WSASYS_STATUS_LEN = 128;
const WSADATA_SIZE = WSADESCRIPTION_LEN + 1 + WSASYS_STATUS_LEN + 1 + 2 + 2 + 2 + 4;
const INVALID_SOCKET = 0xFFFFFFFF;
const SOCKET_ERROR = -1;

export function registerWs2_32(emu: Emulator): void {
  const ws2_32 = emu.registerDll('WS2_32.DLL');

  ws2_32.register('WSAStartup', 2, () => {
    // Per MSDN, WSAStartup negotiates: wsaData.wVersion = min(requested, highest_supported).
    // MFC's AfxSocketInit requests MAKEWORD(1,1) and checks wVersion == 0x0101 — if we
    // return 0x0202 the check fails. Echo the caller's requested version (capped at 2.2).
    const requested = emu.readArg(0) & 0xFFFF;
    const highest = 0x0202;
    const negotiated = requested === 0 ? highest : Math.min(requested, highest);
    const wsaDataPtr = emu.readArg(1);
    if (wsaDataPtr) {
      emu.memory.writeU16(wsaDataPtr, negotiated);   // wVersion
      emu.memory.writeU16(wsaDataPtr + 2, highest);  // wHighVersion
      for (let i = 4; i < WSADATA_SIZE; i++) {
        emu.memory.writeU8(wsaDataPtr + i, 0);
      }
    }
    return 0; // success
  });

  ws2_32.register('WSACleanup', 0, () => 0);
  ws2_32.register('WSAGetLastError', 0, () => 0);

  ws2_32.register('WSAAsyncSelect', 4, () => 0);
  ws2_32.register('WSAEventSelect', 3, () => 0);
  ws2_32.register('WSAEnumNetworkEvents', 3, () => SOCKET_ERROR);

  let nextSocket = 0x100;
  ws2_32.register('socket', 3, () => nextSocket++);
  ws2_32.register('closesocket', 1, () => 0);
  ws2_32.register('connect', 3, () => SOCKET_ERROR);
  ws2_32.register('bind', 3, () => 0); // success
  ws2_32.register('listen', 2, () => 0); // success
  ws2_32.register('accept', 3, () => INVALID_SOCKET);
  ws2_32.register('send', 4, () => SOCKET_ERROR);
  ws2_32.register('recv', 4, () => SOCKET_ERROR);
  ws2_32.register('shutdown', 2, () => 0);
  ws2_32.register('select', 5, () => 0);
  ws2_32.register('setsockopt', 5, () => 0);
  ws2_32.register('ioctlsocket', 3, () => 0);

  ws2_32.register('getpeername', 3, () => SOCKET_ERROR);
  ws2_32.register('getsockname', 3, () => {
    const s = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const namelenPtr = emu.readArg(2);
    if (namePtr && namelenPtr) {
      const len = emu.memory.readU32(namelenPtr);
      // Fill with AF_INET sockaddr: family=2, port=0, addr=127.0.0.1
      if (len >= 16) {
        emu.memory.writeU16(namePtr, 2); // AF_INET
        emu.memory.writeU16(namePtr + 2, 0); // port
        emu.memory.writeU32(namePtr + 4, 0x0100007f); // 127.0.0.1
        for (let i = 8; i < 16; i++) emu.memory.writeU8(namePtr + i, 0);
      }
      emu.memory.writeU32(namelenPtr, 16);
    }
    return 0;
  });

  ws2_32.register('htonl', 1, () => {
    const val = emu.readArg(0);
    return ((val & 0xFF) << 24) | ((val & 0xFF00) << 8) |
           ((val >> 8) & 0xFF00) | ((val >> 24) & 0xFF);
  });

  ws2_32.register('htons', 1, () => {
    const val = emu.readArg(0) & 0xFFFF;
    return ((val & 0xFF) << 8) | ((val >> 8) & 0xFF);
  });

  ws2_32.register('ntohl', 1, () => {
    const val = emu.readArg(0);
    return ((val & 0xFF) << 24) | ((val & 0xFF00) << 8) |
           ((val >> 8) & 0xFF00) | ((val >> 24) & 0xFF);
  });

  ws2_32.register('ntohs', 1, () => {
    const val = emu.readArg(0) & 0xFFFF;
    return ((val & 0xFF) << 8) | ((val >> 8) & 0xFF);
  });

  ws2_32.register('inet_addr', 1, () => INVALID_SOCKET); // INADDR_NONE
  ws2_32.register('inet_ntoa', 1, () => 0);
  ws2_32.register('inet_ntop', 4, () => 0);

  ws2_32.register('gethostname', 2, () => {
    const namePtr = emu.readArg(0);
    const nameLen = emu.readArg(1);
    const name = 'localhost';
    if (namePtr && nameLen > name.length) {
      emu.memory.writeCString(namePtr, name);
      return 0;
    }
    return SOCKET_ERROR;
  });

  ws2_32.register('gethostbyname', 1, () => 0); // NULL = failure
  ws2_32.register('getservbyname', 2, () => 0);
  ws2_32.register('getaddrinfo', 4, () => 11001); // WSAHOST_NOT_FOUND
  ws2_32.register('freeaddrinfo', 1, () => 0);
  ws2_32.register('getnameinfo', 7, () => 11001);

  ws2_32.register('WSASetLastError', 1, () => 0);
  ws2_32.register('WSAIsBlocking', 0, () => 0);
  ws2_32.register('WSACancelBlockingCall', 0, () => 0);
  ws2_32.register('WSACancelAsyncRequest', 1, () => 0);
  ws2_32.register('WSAAsyncGetProtoByName', 5, () => 0);
  ws2_32.register('WSAAsyncGetProtoByNumber', 5, () => 0);
  ws2_32.register('WSAAsyncGetHostByName', 5, () => 0);
  ws2_32.register('WSAAsyncGetHostByAddr', 7, () => 0);
  ws2_32.register('getsockopt', 5, () => SOCKET_ERROR);
  ws2_32.register('sendto', 6, () => SOCKET_ERROR);
  ws2_32.register('recvfrom', 6, () => SOCKET_ERROR);
  ws2_32.register('gethostbyaddr', 3, () => 0);
  ws2_32.register('getprotobyname', 1, () => 0);
  ws2_32.register('getprotobynumber', 1, () => 0);
  ws2_32.register('getservbyport', 2, () => 0);

  ws2_32.register('WSAAddressToStringA', 5, () => SOCKET_ERROR);
  ws2_32.register('WSAIoctl', 9, () => SOCKET_ERROR);
}
