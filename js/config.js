/* Optional settings. Leave as-is to use the free public PeerJS server and Google's STUN servers.
 *
 * peerServer: run your own PeerJS server (https://github.com/peers/peerjs-server) if the
 *             public one is slow or down, e.g. { host: 'peer.example.com', port: 443, path: '/', secure: true }
 * iceServers: add a TURN server here if some friends can't connect (strict office/school/mobile networks),
 *             e.g. [{ urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }]
 */
window.WATCHROOM_CONFIG = {
  peerServer: null,
  iceServers: [],
};
