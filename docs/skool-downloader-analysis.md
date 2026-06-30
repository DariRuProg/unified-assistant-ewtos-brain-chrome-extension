# Skool Video Downloader Analysis

## Source and artifacts inspected
- Source repo: `c:\Users\darwi\Downloads\skool-downloader-4.0.13\skool-downloader-4.0.13`
- Inspected files:
  - `README.md`
  - `ACTOR.md`
  - `package.json`
  - `LICENSE`
  - `CHANGELOG.md`
  - `data/readme.json`
  - `.actor/actor.json`
- Actual executable source appears to be missing from the repo. The only JS file present is `index.js`, which is placeholder-like, and there is no `extension/` or `src/` folder with browser extension implementation.

## What the product claims to do
- Browser extension for Skool videos.
- Detects video sources in Skool pages:
  - Native Skool player
  - Loom
  - Vimeo
  - YouTube
  - Wistia
- Adds a floating download button on Skool pages.
- Lets users choose quality and download as MP4.
- Supports download queue, real-time progress, and up to 3 concurrent downloads.
- Uses the user's active browser session to access protected Skool content.

## Monetization and licensing
- Product appears to follow a freemium/trial model:
  - 3 free downloads included after sign-in with email and one-time code.
  - Unlimited downloads require purchase of a license.
- `package.json` declares `MIT`, but `LICENSE` is proprietary and restrictive.
- The license text explicitly permits only personal viewing and forbids copying, modification, distribution, commercial use, and reverse engineering without permission.
- This is a clear license mismatch: metadata claims open source, but actual license is closed.

## Evidence about code path
- Relevant artifact files in the Skool repo are mostly documentation and metadata.
- There is no found browser extension source code or manifest in the repo contents.
- The technical behavior is described in docs, not implemented in checked-in source.

## Relevant target project code paths for integration
### Chrome extension layer
- `extension/manifest.json`
  - MV3 extension with permissions: `sidePanel`, `storage`, `scripting`, `tabs`, `alarms`, `contextMenus`, `clipboardWrite`, `downloads`
  - `host_permissions`: `<all_urls>`
- `extension/background.js`
  - Service worker and tool dispatcher
  - Context menu setup
  - Message handling for extension state and page actions
- `extension/tools/auto_brain.js`
  - Example of hybrid server/extension flow via fetch to server endpoints
- `extension/tools/page_scrape.js`
  - Executes page-context scraping via `chrome.scripting.executeScript`
- `extension/tools/scrape_dom.js`
  - Self-contained DOM scraper function used in page context

### Server layer
- `server/bridge.py`
  - WebSocket bridge that delivers `tool_call` / `tool_result` between extension and server
- `server/routers/web_tools.py`
  - HTTP endpoints for browser tools and hybrid scraping
  - `POST /tools/youtube_transcript`
  - `POST /tools/page_scrape`
  - `POST /tools/seo_check`
  - `POST /tools/image_analyse`
  - `POST /tools/color_picker`
  - `POST /tools/screenshot`
  - `POST /tools/url_extractor`
- `server/routers/video_brain.py`
  - Video sync endpoints for Supabase integration
- `server/tools/youtube_metadata.py`
  - Example backend use of `yt-dlp` and oEmbed to extract metadata

### Useful patterns in this repo
- Browser tool integration is implemented as: extension tool → WS bridge → server endpoint.
- Page interaction tools use `chrome.scripting.executeScript` to inject self-contained page code.
- Hybrid workflows can call server endpoints first and fall back to extension/browser scraping.
- The extension already has download permission support via `downloads` in `manifest.json`.

## Practical conclusion
- The Skool downloader repo does not contain a directly reusable implementation; it contains product docs and metadata only.
- For `EwtosBrain`, the best path is to use the existing extension/server tool architecture to add a new Skool/video extraction capability.
- Relevant integration points are:
  1. New extension browser tool (e.g. `extension/tools/skool_downloader.js`)
  2. New server route under `server/routers/` (or extend `web_tools.py`)
  3. Use `server/bridge.py` and `extension/background.js` for tool dispatch
  4. Leverage `manifest.json` permissions for downloads and page scripting
  5. Use the existing DOM injection pattern in `scrape_dom.js` as a model

## Graphify in this repo
- This repo already includes Graphify artifacts for the current EwtosBrain codebase in `graphify-out/`.
- Key files:
  - `graphify-out/graph.html` — interactive graph visualization for the repo
  - `graphify-out/GRAPH_REPORT.md` — graph summary and community hubs
  - `graphify-out/graph.json` — raw graph data
- Use these artifacts to understand EwtosBrain’s current architecture, the main code hubs, and how extension/server tools are connected.
- For the Skool downloader analysis, `docs/skool-downloader-analysis.md` is the central note in this repo.

## Recommended next step
- If the actual Skool download logic is needed, obtain the full extension source or reverse-engineer the runtime from a released package/extension bundle.
- Meanwhile, this document can guide the implementation design and highlight the lack of an actual source path in the inspected Skool repo.
