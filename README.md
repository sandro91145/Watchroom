# Watchroom

Watch YouTube, Vimeo, Twitch and Dailymotion videos and video files in sync with friends. Make a room, send the link, press play.

- **My Rooms**: every room you create or join is saved in your browser, with a live check of who's inside right now
- **Named rooms with invites**: a 6-character code, an invite link, a QR code, and one-tap sharing to WhatsApp, Telegram or your phone's share menu
- **Synced playback**: play, pause and seeking happen for everyone, and late joiners land at the right second
- **Videos from many places**: YouTube (links, playlists and search), Vimeo, Twitch past broadcasts and live channels, Dailymotion, and direct video files (`.mp4`, `.webm`, `.m3u8`)
- **Room controls**: an owner and moderators, settings for who can play, add videos and chat, vote to skip, mute, remove people, and password-protected rooms
- **Waits for slow connections**: if someone's video is loading, the room pauses until everyone can play
- **Clickable timestamps**: type `12:34` in chat and anyone can click it to take the room there
- **Share a tab**: stream one of your browser tabs to the room and browse YouTube or any site there while everyone watches
- **Shared queue**: add, reorder, remove, play now; the next video starts when one ends
- **Chat** and a **people** list
- **No server and no accounts**: it's a static site; browsers talk to each other peer-to-peer

## Use it

1. Open the site, type your name, click **Create a room** and give it a name.
2. The **Invite** window opens: copy the link, scan the QR code, or send it with WhatsApp or Telegram. Reopen it any time with **Invite** in the top bar.
3. Paste a link into the bar under the player and click **Play now** or **Add to queue**. If search is set up, type words instead of a link to search YouTube.

Links that work:

| Site | Examples | Notes |
|---|---|---|
| YouTube | `youtube.com/watch?v=…`, `youtu.be/…`, `shorts/…`, `&t=1m30s` | Age-restricted videos can't play in any embedded player; use **Share a tab** for those |
| YouTube playlists | `youtube.com/playlist?list=…` | Adds up to 100 videos to the queue. A video link that's part of a playlist adds just that video |
| Vimeo | `vimeo.com/123456789`, unlisted `vimeo.com/123456789/abcdef1234` | The uploader must allow embedding |
| Twitch | `twitch.tv/videos/…` (past broadcasts), `twitch.tv/channelname` (live) | Live channels sync play and pause only. Clips can't be synced |
| Dailymotion | `dailymotion.com/video/x…`, `dai.ly/x…` | Needs a Player ID in `js/config.js` (see below) |
| Video files | links ending in `.mp4`, `.webm`, `.m3u8` | The link must point at the file itself |

### My Rooms

Next time you open the site you land on **My Rooms**: every room you've created or joined, newest first. Each one shows who's inside right now (it re-checks every 20 seconds, or press the refresh button).

- **Click a room** to go in. If people are inside you join them; if it's empty you reopen it under the same code, with its name, video and queue restored, so old invite links keep working.
- **☰ menu**: rename it, copy its invite link, or remove it from the list.
- **Your name** (top right) can be changed any time.

Rooms are saved in your browser only. Another browser or device starts with an empty list until you open your rooms there.

### Room controls

Whoever creates a room is its **owner**. Open the **People** tab:

- The **⋯** menu next to a person lets the owner **make them a moderator**, and lets the owner and moderators **mute them in chat** or **remove them from the room**. Removed people can't rejoin until someone clicks **Let back in** under **Room settings**.
- **Room settings** (owner and moderators only):
  - **Play, pause & skip**: everyone, or moderators only. Others' presses are undone and they see why.
  - **Add videos**: everyone, or moderators only.
  - **Chat**: everyone, or moderators only.
  - **Skipping**: instant, or **vote** — a skip happens once more than half the room has voted. Moderators always skip instantly.
  - **Wait when someone is loading**: on by default (see below).
  - **Password**: people joining must type it. Everyone already inside, the owner and moderators don't need it, and each browser remembers a password that worked. My Rooms shows a private room as "Private · 3 inside" without names.

Roles belong to your browser, not to a name: each browser has its own private signing key and proves it when joining, so roles survive the room changing hands and can't be claimed by typing someone's name. A different browser or device starts as a regular member.

### Waiting for slow connections

If someone's video stalls for more than a moment, or a new video is still loading for them, the room pauses with a **Waiting for … to load** banner and carries on as soon as everyone can play. It never waits longer than 12 seconds, and someone whose connection keeps falling behind stops holding the room up for a minute. Owners and moderators can turn this off in Room settings.

### Clickable timestamps

Times like `0:42` or `1:02:03` in chat, including the room's own "paused at 12:34" messages, become buttons. Clicking one takes everyone there (if you're allowed to control playback).

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

## Optional setup

These go in `js/config.js`. Commit the change and the site updates in about a minute.

### YouTube search (and faster playlists)

Search needs a free YouTube Data API key from Google:

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project (any name).
2. In **APIs & Services → Library**, find **YouTube Data API v3** and click **Enable**.
3. In **APIs & Services → Credentials**, click **Create credentials → API key**.
4. Edit the key. Under **Application restrictions** choose **Websites** and add `https://<your-username>.github.io/*`. Under **API restrictions** choose **Restrict key** and pick **YouTube Data API v3**.
5. Paste the key as `youtubeApiKey` in `js/config.js`.

The key is visible in the site's code, which is normal for browser-side keys; the website restriction stops other sites from using it. The free quota allows roughly 100 searches a day across everyone using the site. Without a key, search is off and playlists still work (titles load a little slower).

### Dailymotion

Dailymotion only lets sites control its player through a player you create. In **Dailymotion Studio**, open **Players**, create one, and paste its Player ID (it looks like `x1abcd`) as `dailymotionPlayerId` in `js/config.js`.

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
- **The host**: whoever creates the room. Their browser keeps the room state (current video, position, queue, chat, rules) and relays it. Guests send their actions to the host, who checks them against the room's rules, applies them and broadcasts the result.
- **Identity**: each browser makes a private ECDSA signing key (kept in IndexedDB, never sent). On joining, the host sends a one-time challenge and the browser signs it; the room knows people by the hash of their public key. Owner, moderator, mute and removal lists use these ids, so they stay correct after a host handover.
- **Passwords**: the room keeps a salted SHA-256 hash, never the password itself.
- **Tab sharing**: the sharer's browser sends the tab's video and audio straight to each person in the room as a WebRTC stream. The sharer uploads one copy per viewer, so it works best for small groups (up to about 5 viewers on a typical home connection). Video uses VP9 for up to 2 viewers and H.264 (usually hardware-encoded, lighter on the CPU) for larger groups; audio is stereo Opus at 128 kb/s instead of WebRTC's mono voice default.
- **Sync**: state is stored as "at host time *T* the video was at position *P*, playing or paused". Guests measure the offset between their clock and the host's with ping/pong, compute where the video should be, and seek when they drift more than about 1.25 s.
- **My Rooms check**: the lobby briefly connects to each saved room and asks who's inside; the room answers with names and what's playing, then hangs up. Nothing is stored on a server.
- **Host leaves**: the owner, then a moderator, then whoever has been in the room longest re-opens it under the same code, and everyone else reconnects to them. The video, queue and rules carry over.
- **Other sites**: Vimeo, Twitch and Dailymotion are driven through their official player scripts, so their own controls, captions and ads work as usual.

## Limits

- **Some YouTube videos won't play from a link.** Uploaders can turn off playback on other sites, and YouTube blocks **age-restricted** videos in every embedded player, including this one. You'll see a message with an **Open on YouTube** button and a **Skip** option. To watch one together, the person with an age-verified YouTube account opens it in their own browser and uses **Share a tab**.
- **Tab sharing quality** depends on the sharer's upload speed and drops as more people watch.
- **Direct links must point at the file itself** (the URL ends in `.mp4`, `.webm` or `.m3u8`, or serves one). Pages that merely contain a video won't work, and some hosts block playback on other sites.
- **Room rules rely on the host's browser**, because there's no server. Whoever is relaying the room could, with modified code, ignore its rules. Roles can't be faked by others, but don't treat a password room as a vault.
- **Removing someone** blocks their browser. Someone determined can come back from another browser or after clearing site data; a password stops that.
- **Strict networks** (some offices, schools and mobile carriers) block peer-to-peer connections. Add a TURN server in `js/config.js` if a friend can't join.
- **The public PeerJS server** is free and occasionally slow. You can run your own and set it in `js/config.js`.
- Browsers may block autoplay with sound for someone who just joined. They'll see **Tap to join playback**.

## Files

```
index.html           page markup
css/style.css        styles (dark and light themes)
js/app.js            rooms, sync, player, UI
js/config.js         optional settings: YouTube API key, Dailymotion Player ID, PeerJS server, TURN
vendor/              PeerJS 1.5.4, hls.js 1.5.13, qrcode-generator 1.4.4 (MIT, Apache-2.0, MIT)
```

## License

MIT
