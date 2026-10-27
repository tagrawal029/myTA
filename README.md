# myTA

A Windows desktop app that sits on top of your notes while you do homework. A small pixel monkey (tanrushu) reads the problem you're working on, watches your work, and puts a red box around a step when something's off. You can ask it for a hint or a short video, but it won't give you the answer.

Started at HackTX 2026.

## Features

- **Only shows up where you work.** It appears in note-taking and whiteboard apps (OneNote, Paint, Word, Notion, Obsidian, Miro, a PDF) and in browser tabs for sites like Google Docs or Excalidraw. Switch to anything else and it hides.
- **Reads the problem itself.** When you open your notes it finds the problem on the page. If there are a few, it asks which one you're on. If the page is just notes, it waits until you start a problem.
- **Checks your work as you write.** When you finish a line it takes a look. If something's wrong it boxes the exact part and tells you what went wrong in that line, without telling you the fix. Fix it and the box goes away.
- **Hint and Video.** Hints get more specific each time you ask. Video opens a YouTube clip at the minute that explains the concept.
- **Classes.** Add your classes and their topics (or drop in the syllabus) and it sticks to methods you've actually covered.
- **Custom sprite.** Swap the monkey for a photo of your TA or your dog. The cutout runs locally.

## Setup

You need Node 20+ on Windows, a [Gemini API key](https://aistudio.google.com/apikey), and a [SerpApi key](https://serpapi.com/) for videos.

```bash
npm install
npm run build
npm start
```

Setup opens the first time. Paste both keys and hit **Save & test keys**. Keys are stored encrypted with Windows' per-user encryption and are only sent to Google and SerpApi.

If npm asks before running install scripts, allow them for `electron`, `koffi` and `esbuild`.

## How it works

- **Electron + React + TypeScript.** The monkey and its buttons live in a small always-on-top window that never takes focus. The red box is drawn on a separate transparent layer that lets clicks through.
- **Seeing the screen.** It finds the window in front with Win32 calls (through `koffi`) and reads browser tab addresses with Windows UI Automation. Screenshots come from Electron's `desktopCapturer`, and myTA's own windows are excluded from them.
- **Deciding when to look.** A tiny grayscale thumbnail is compared a few times a second. A read only happens after your work changes and then stays still for a moment, so it isn't checking half-written lines.
- **Gemini.** One call works out the problem (the answer stays in the app), one reviews your work against it, and one writes hints. If a model is overloaded or slow, it falls back to another one the key has access to.
- **Not giving away the answer.** Everything shown to you goes through a check first: a direct comparison against the answer and its equivalent forms, then a second model that judges it. If either flags it, you get a generic nudge instead.

## Tests

```bash
npm test              # unit tests
npm run e2e           # drives the real app with scripted Gemini/SerpApi responses
node e2e/real-input.mjs   # real mouse clicks; don't touch the mouse while it runs
```
