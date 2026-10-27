# Watchroom

Watch YouTube videos and video files in sync with friends. Make a room, send the link, press play.

- **Rooms with a 6-character code** and a shareable invite link (`…/watchroom/#K7QX2M`)
- **Synced playback**: play, pause and seeking happen for everyone, and late joiners land at the right second
- **YouTube links** (`watch?v=`, `youtu.be/`, `shorts/`, `&t=` start times) and **direct video links** (`.mp4`, `.webm`, `.m3u8` streams)
- **Shared queue**: add, reorder, remove, play now; the next video starts when one ends
- **Chat** and a **people** list
- **No server and no accounts**: it's a static site; browsers talk to each other peer-to-peer

## Use it

1. Open the site, type your name, click **Create a room**.
2. Click **Copy link** in the top bar and send it to your friends.
3. Paste a link into the bar under the player and click **Play now** or **Add to queue**.

Everyone in the room can control playback, like Watch2gether.

## Deploy on GitHub Pages

The repo is ready to serve as-is.

1. Go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Push to `main` (or run the **Deploy to GitHub Pages** workflow from the **Actions** tab).

The site appears at `https://<your-username>.github.io/watchroom/`.

To try it locally, serve the folder over HTTP (YouTube's player won't run from `file://`):

```sh
python3 -m http.server 8080
# then open http://localhost:8080 in two browser windows
```

## How it works

- **Connections**: [PeerJS](https://peerjs.com) handles WebRTC. Its free public server only introduces browsers to each other; video, chat and controls go directly between browsers.
- **The host**: whoever creates the room. Their browser keeps the room state (current video, position, queue, chat) and relays it. Guests send their actions to the host, who applies them and broadcasts the result.
- **Sync**: state is stored as "at host time *T* the video was at position *P*, playing or paused". Guests measure the offset between their clock and the host's with ping/pong, compute where the video should be, and seek when they drift more than about 1.25 s.
- **Host leaves**: the guest who has been in the room longest re-opens it under the same code, and everyone else reconnects to them. The video and queue carry over.

## Limits

- **Some YouTube videos won't play.** Uploaders can turn off playback on other sites, and YouTube blocks **age-restricted** videos in every embedded player, including this one. You'll see a message with an **Open on YouTube** button and a **Skip** option. Videos from direct links don't have this restriction.
- **Direct links must point at the file itself** (the URL ends in `.mp4`, `.webm` or `.m3u8`, or serves one). Pages that merely contain a video won't work, and some hosts block playback on other sites.
- **Strict networks** (some offices, schools and mobile carriers) block peer-to-peer connections. Add a TURN server in `js/config.js` if a friend can't join.
- **The public PeerJS server** is free and occasionally slow. You can run your own and set it in `js/config.js`.
- Browsers may block autoplay with sound for someone who just joined. They'll see **Tap to join playback**.

## Files

```
index.html           page markup
css/style.css        styles (dark and light themes)
js/app.js            rooms, sync, player, UI
js/config.js         optional PeerJS server / TURN settings
vendor/              PeerJS 1.5.4 and hls.js 1.5.13 (MIT and Apache-2.0)
```

## License

MIT
