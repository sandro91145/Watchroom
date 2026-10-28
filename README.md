# Watchroom

Watch YouTube videos and video files in sync with friends. Make a room, send the link, press play.

- **My Rooms**: every room you create or join is saved in your browser, with a live check of who's inside right now
- **Named rooms with invites**: a 6-character code, an invite link, a QR code, and one-tap sharing to WhatsApp, Telegram or your phone's share menu
- **Synced playback**: play, pause and seeking happen for everyone, and late joiners land at the right second
- **YouTube links** (`watch?v=`, `youtu.be/`, `shorts/`, `&t=` start times) and **direct video links** (`.mp4`, `.webm`, `.m3u8` streams)
- **Share a tab**: stream one of your browser tabs to the room and browse YouTube or any site there while everyone watches
- **Shared queue**: add, reorder, remove, play now; the next video starts when one ends
- **Chat** and a **people** list
- **No server and no accounts**: it's a static site; browsers talk to each other peer-to-peer

## Use it

1. Open the site, type your name, click **Create a room** and give it a name.
2. The **Invite** window opens: copy the link, scan the QR code, or send it with WhatsApp or Telegram. Reopen it any time with **Invite** in the top bar.
3. Paste a link into the bar under the player and click **Play now** or **Add to queue**.

### My Rooms

Next time you open the site you land on **My Rooms**: every room you've created or joined, newest first. Each one shows who's inside right now (it re-checks every 20 seconds, or press the refresh button).

- **Click a room** to go in. If people are inside you join them; if it's empty you reopen it under the same code, with its name, video and queue restored, so old invite links keep working.
- **☰ menu**: rename it, copy its invite link, or remove it from the list.
- **Your name** (top right) can be changed any time.

Rooms are saved in your browser only. Another browser or device starts with an empty list until you open your rooms there.

Everyone in the room can control playback, like Watch2gether.

### Share a tab

For anything a link can't play, click **Share a tab** under the player:

1. Your browser asks what to share. Choose the **Chrome tab** (or **Edge tab**) option, pick a tab, and leave **Share tab audio** on.
2. Use that tab as normal: search, open YouTube, sign in, play videos. Everyone in the room sees and hears it live in the player.
3. Click **Stop sharing** (or the browser's own stop button) when you're done. Starting a video from the link bar also ends the share.

While you share, pick the quality under the player:

| Preset | Picture | Upload per viewer |
|---|---|---|
| Smooth | 720p, 30 fps | about 2.6 Mbps |
| Sharp (default) | 1080p, 30 fps | about 5.1 Mbps |
| Max | 1080p, 60 fps | about 9.1 Mbps |

The panel shows the total upload needed for the people watching. Sound is sent in stereo at 128 kb/s. For the sharpest picture, maximise the shared tab's window, put the video in fullscreen inside it, and set YouTube's own quality to 1080p.

Sharing works in desktop Chrome and Edge. Firefox and Safari can share a tab without sound. Phones can watch shares but not start them.

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
- **Tab sharing**: the sharer's browser sends the tab's video and audio straight to each person in the room as a WebRTC stream. The sharer uploads one copy per viewer, so it works best for small groups (up to about 5 viewers on a typical home connection). Video uses VP9 for up to 2 viewers and H.264 (usually hardware-encoded, lighter on the CPU) for larger groups; audio is stereo Opus at 128 kb/s instead of WebRTC's mono voice default.
- **Sync**: state is stored as "at host time *T* the video was at position *P*, playing or paused". Guests measure the offset between their clock and the host's with ping/pong, compute where the video should be, and seek when they drift more than about 1.25 s.
- **My Rooms check**: the lobby briefly connects to each saved room and asks who's inside; the room answers with names and what's playing, then hangs up. Nothing is stored on a server.
- **Host leaves**: the guest who has been in the room longest re-opens it under the same code, and everyone else reconnects to them. The video and queue carry over.

## Limits

- **Some YouTube videos won't play from a link.** Uploaders can turn off playback on other sites, and YouTube blocks **age-restricted** videos in every embedded player, including this one. You'll see a message with an **Open on YouTube** button and a **Skip** option. To watch one together, the person with an age-verified YouTube account opens it in their own browser and uses **Share a tab**.
- **Tab sharing quality** depends on the sharer's upload speed and drops as more people watch.
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
vendor/              PeerJS 1.5.4, hls.js 1.5.13, qrcode-generator 1.4.4 (MIT, Apache-2.0, MIT)
```

## License

MIT
