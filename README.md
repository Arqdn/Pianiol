# Pianiol 🎹

**Find a song. Watch the notes fall. Play along on any instrument.**

Pianiol is a Synthesia-style falling-notes app that runs entirely in the browser — no build step, no server, no samples. Ask it for a song and it rains the notes down onto a piano keyboard, played on your choice of eight synthesized instruments.

## Features

- **Falling-notes player** — smooth canvas renderer with a playable on-screen piano (tap/click/glissando), hand-colored notes (melody teal, accompaniment orange), speed control (0.5×–1.5×), transpose (±12 semitones), and seeking.
- **8 instruments** — Piano, E-Piano, Music Box, Guitar, Synth Lead, Strings, Flute, Marimba — all synthesized live with WebAudio.
- **Paste any link → AI writes the notes** — paste a YouTube or TikTok link (or just type a song name). Pianiol reads the video title, checks its built-in library, and if the song isn't there it asks an AI model to write out the melody and accompaniment from its knowledge of the piece, then plays it on your chosen instrument. Works with your own **Anthropic** key (Claude) or **OpenRouter** key (NVIDIA Nemotron Ultra free tier by default, any OpenRouter model selectable), entered once in **✨ AI notes** (stored only on your device) or via a one-tap setup link (`#setup&provider=openrouter&key=…`). Searching public MIDI archives (BitMidi, Internet Archive) is available as an optional fallback.
- **Built-in library** — 13 public-domain pieces encoded with melody + accompaniment (Für Elise, Canon in D, Clair de Lune, Moonlight Sonata, Gymnopédie No. 1, and more), searchable offline.
- **Share from YouTube / TikTok** — install Pianiol as a PWA on Android and it appears in the YouTube and TikTok share sheets. Sharing a video runs the same link → notes pipeline. On other platforms, use **Paste a link** or paste straight into the search box.
- **Exact notes from audio** — the actual notes of the actual recording: Spotify's open-source **Basic Pitch** neural pitch model runs in the browser (TensorFlow.js, vendored, ~2 MB) and transcribes melody *and* accompaniment from an uploaded audio/video file, a file shared into the app from your phone's gallery, the audio of the browser tab playing the video (desktop), or the microphone. Octave-ghost filtering keeps the output clean; nothing leaves the device.
- **Learn mode** — the notes stop at the keyboard and wait until you play the right key(s); practise both hands or one at a time while the other plays itself, with key hints, a wrong-key flash, an A–B section loop, and live accuracy stats. Play on the screen keyboard or plug in a **MIDI keyboard** (Web MIDI).
- **AI coach** — after you've practised, the coach reads your stats (weak bars, wrong keys, reaction time) and replies with specific feedback plus a plan — hands, speed and a bar range — that you apply with one tap.
- **Import MIDI** — drop in any Standard MIDI file (format 0/1/2, tempo maps, running status all handled) and it becomes a falling-notes track.
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
3. The shared `title`/`text`/`url` arrive as query params. Pianiol extracts the video URL and fetches the video's title through oEmbed (noembed.com, with YouTube/TikTok oEmbed fallbacks).
4. The title is cleaned up ("(Official Video)", hashtags, "feat. …", "| 1 hour" …) and split into artist/title queries.
5. The queries run against the built-in library first (instant, offline). A strong match plays immediately.
6. Otherwise **AI writes the notes**: the browser calls the provider directly and streams the reply so the sheet shows progress. With Anthropic it uses `claude-opus-5` (or `claude-sonnet-5`) with a structured-output JSON schema and server-side refusal fallbacks; with OpenRouter it uses the OpenAI-compatible chat endpoint (default `nvidia/llama-3.1-nemotron-ultra-253b-v1:free`, auto-resolving the id from OpenRouter's model list if it changes) with a JSON-only prompt and a tolerant JSON extractor. Either way the model returns the melody and a left-hand accompaniment as beat-based note data plus a confidence rating; Pianiol validates every note and plays it.
7. If AI is unavailable (no key, or it fails) and the optional online toggle is on, Pianiol searches public MIDI archives — BitMidi and the Internet Archive — downloads the best `.mid`, parses it, and plays it.
8. Still nothing — or you want the *exact* notes rather than the AI's memory of the piece? Tap **🎧 Exact notes from audio** and give Pianiol the recording (file, shared video, tab audio or microphone).

## Learning a song

Switch the player to **🎓 Learn**. Playback runs until the next note of the hand you're practising, then freezes with the key(s) highlighted until you play them (a wrong key flashes red and counts as a miss; playing a hair early is fine). Choose *Both / Right / Left* — the other hand plays automatically. Use **A**/**B** to loop a section. **✨ Coach** sends your stats to the configured AI and comes back with feedback and a next-step plan (hands, speed, bars) that **Do it** applies. **🎹 MIDI keyboard** connects a real keyboard via Web MIDI.

Your API key is stored in this device's localStorage and sent only to `api.anthropic.com`. Set a spending limit on the key; a typical song costs a few cents. Pianiol never downloads or rips audio from YouTube/TikTok — it matches by title, and Listen mode just uses your microphone.

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
js/finder.js          link/name → notes resolver (library → AI → optional MIDI archives)
js/ai.js              Claude API client: streaming, structured-output song schema, key storage
js/midi.js            Standard MIDI File parser
js/transcribe-ml.js   exact notes from audio: Basic Pitch inference, file decode, mic/tab capture
js/pcm-worklet.js     AudioWorklet that streams PCM from a capture
js/coach.js           AI practice coach (stats → feedback + plan)
js/midi-input.js      Web MIDI keyboard input
js/transcribe.js      lightweight single-voice pitch tracker (fallback)
vendor/basic-pitch/   Basic Pitch model + TF.js bundle (Apache-2.0, see LICENSE)
manifest.webmanifest  PWA manifest incl. share_target
sw.js                 offline service worker
```

All plain ES modules — no dependencies, no bundler.
