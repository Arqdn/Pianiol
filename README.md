# Pianiol 🎹

**Find a song. Watch the notes fall. Play along on any instrument.**

Pianiol is a Synthesia-style falling-notes app that runs entirely in the browser — no build step, no server, no samples. Ask it for a song and it rains the notes down onto a piano keyboard, played on your choice of eight synthesized instruments.

## Features

- **Falling-notes player** — smooth canvas renderer with a playable on-screen piano (tap/click/glissando), hand-colored notes (melody teal, accompaniment orange), speed control (0.5×–1.5×), transpose (±12 semitones), and seeking.
- **8 instruments** — Piano, E-Piano, Music Box, Guitar, Synth Lead, Strings, Flute, Marimba — all synthesized live with WebAudio.
- **Find a song** — fuzzy search over a built-in library of public-domain pieces (Für Elise, Canon in D, the Tetris theme, and many more).
- **Share from YouTube / TikTok** — install Pianiol as a PWA on Android and it appears in the YouTube and TikTok share sheets. Share a video and Pianiol looks up its title (via oEmbed) and matches it to notes in the library. On other platforms, use **Paste a link**.
- **Import MIDI** — drop in any Standard MIDI file (format 0/1/2, tempo maps, running status all handled) and it becomes a falling-notes track.
- **Listen mode** — no MIDI and not in the library? Play the song out loud and Pianiol transcribes the melody by ear with real-time pitch detection (mic + autocorrelation), then plays it back as falling notes.
- **PWA** — installable, works offline via a service worker.

## Running it

It's a static site — serve the folder over HTTP(S) and open it:

```sh
cd Pianiol
python3 -m http.server 8080
# → http://localhost:8080
```

> The **share target** and **installation** require HTTPS (or localhost). Host it on GitHub Pages / Netlify / any static host to use the share-from-YouTube/TikTok flow on your phone.

## How share-to-Pianiol works

1. The web app manifest declares a [`share_target`](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target) (GET).
2. Once installed on Android, "Pianiol" shows up in any app's share sheet — including YouTube and TikTok.
3. The shared `title`/`text`/`url` arrive as query params. Pianiol extracts the video URL, fetches the video's title through oEmbed (noembed.com, with YouTube/TikTok oEmbed fallbacks), cleans it up ("(Official Video)", hashtags, "feat. …" etc.), and fuzzy-matches it against the song library.
4. No match? Listen mode or MIDI import will still get you the notes.

Pianiol never downloads or rips audio from YouTube/TikTok — it matches by title, and Listen mode just uses your microphone.

## Project layout

```
index.html            app shell (home, player, share/link/listen sheets)
css/style.css         dark stage theme
js/app.js             screens, search UI, share-target flow, player controls
js/engine.js          falling-notes canvas renderer + audio scheduler + touch keyboard
js/synth.js           WebAudio instrument engine (8 instruments)
js/library.js         song format helpers (beats → seconds, pitch parsing)
js/songs-data.js      the built-in song library (public-domain pieces)
js/search.js          title normalization + fuzzy matching
js/share.js           share-target params, oEmbed lookup, thumbnails
js/midi.js            Standard MIDI File parser
js/transcribe.js      microphone melody transcription (Listen mode)
manifest.webmanifest  PWA manifest incl. share_target
sw.js                 offline service worker
```

All plain ES modules — no dependencies, no bundler.
