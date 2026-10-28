/* Optional settings. Leave as-is to use the free public PeerJS server and Google's STUN servers.
 *
 * peerServer: run your own PeerJS server (https://github.com/peers/peerjs-server) if the
 *             public one is slow or down, e.g. { host: 'peer.example.com', port: 443, path: '/', secure: true }
 * iceServers: add a TURN server here if some friends can't connect (strict office/school/mobile networks),
 *             e.g. [{ urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }]
 */
/* youtubeApiKey: turns on YouTube search in rooms, and faster playlist loading with titles.
 *   Free from Google Cloud (YouTube Data API v3). Restrict the key to your site's address.
 *   Each search uses about 100 of the 10,000 free daily units, so roughly 100 searches a day.
 * dailymotionPlayerId: needed to play Dailymotion links. Create a free player in Dailymotion
 *   Studio (Players tab) and paste its ID here, e.g. 'x1abcd'.
 */
window.WATCHROOM_CONFIG = {
  peerServer: null,
  iceServers: [],
  youtubeApiKey: '',
  dailymotionPlayerId: '',
};
