# TabMind — Project Overview

> **Version**: 4.6.0 · **Manifest**: V3 · **Runtime**: Chrome Extension

TabMind is an intelligent workspace manager for browser tabs. It lets users save, organize, restore, and manage browser window snapshots (called "workspaces"), featuring AI-powered tab organization and summary generation via multiple AI providers (Ollama, Gemini, OpenRouter, Groq), plus a preference learning system that adapts to user behavior over time.

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Project Structure](#project-structure)
3. [Architecture Overview](#architecture-overview)
4. [Data Model](#data-model)
5. [Features & Technical Implementation](#features--technical-implementation)
   - [5.1 Workspace CRUD](#51-workspace-crud)
   - [5.2 Search & Sort](#52-search--sort)
   - [5.3 Statistics & AI Insights](#53-statistics--ai-insights)
   - [5.4 AI-Powered Workspace Summaries](#54-ai-powered-workspace-summaries)
   - [5.5 AI Tab Organization (Flagship Feature)](#55-ai-tab-organization-flagship-feature)
   - [5.6 Preference Learning System](#56-preference-learning-system)
   - [5.7 Import / Export with Conflict Resolution](#57-import--export-with-conflict-resolution)
   - [5.8 AI Settings](#58-ai-settings)
   - [5.9 CORS Bypass (Service Worker)](#59-cors-bypass-service-worker)
6. [Build & Configuration](#build--configuration)
7. [Notable Implementation Details](#notable-implementation-details)

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime** | Chrome Extension Manifest V3 |
| **Language** | Vanilla JavaScript (ES Modules) — no TypeScript, no framework |
| **Build** | Vite 5.2+ with `@crxjs/vite-plugin` ^2.0.0-beta.28 |
| **Linting** | ESLint (flat config), `globals` (browser / web-extensions / node) |
| **AI / LLM** | Multi-provider: Ollama (local), Google Gemini, OpenRouter, Groq. All via unified `AIProviderService` |
| **Storage** | `chrome.storage.local` |
| **Browser APIs** | `chrome.tabs`, `chrome.windows`, `chrome.runtime`, `chrome.declarativeNetRequest` |
| **CSS** | Pure CSS with CSS custom properties (no preprocessor) |
| **UI** | Single-page popup (`index.html`) |

**Runtime dependencies**: Zero. All code is hand-written vanilla JS.

---

## Project Structure

```
TabMind/
├── package.json                  # Scripts: dev, build
├── vite.config.js                # Vite + @crxjs/vite-plugin configuration
├── manifest.json                 # Chrome Extension manifest (source)
├── eslint.config.js              # ESLint flat config
├── LOGO.png
├── public/assets/                # Static icons & logo
│   ├── logo.png
│   ├── icon-{16,32,48,128}.png
├── src/
│   ├── config.js                 # Central constants (limits, weights, defaults)
│   ├── background/
│   │   └── service-worker.js     # Background service worker (CORS proxy, lifecycle)
│   ├── popup/
│   │   ├── index.html            # Single popup page
│   │   ├── popup.js              # Main controller (~2600 lines)
│   │   └── style.css             # Full styling (~2250 lines)
│   ├── services/
│   │   ├── chrome-service.js     # chrome.tabs / chrome.windows abstraction
│   │   ├── storage-service.js    # chrome.storage.local CRUD layer
│   │   ├── aiProviderService.js  # Unified multi-provider AI abstraction
│   │   ├── providers/            # Individual provider implementations
│   │   │   ├── ollamaProvider.js
│   │   │   ├── geminiProvider.js
│   │   │   ├── openRouterProvider.js
│   │   │   ├── groqProvider.js
│   │   │   └── prompts.js        # Shared prompt templates + parsing
│   │   ├── summaryService.js     # AI workspace summary generation (uses AIProviderService)
│   │   ├── preferenceService.js  # User behavior learning system
│   │   ├── import-manager.js     # Import conflict detection & resolution
│   └── utils/
│       └── crypto.js             # Workspace ID generation (crypto.randomUUID)
└── dist/                         # Vite build output (loaded as unpacked ext)
```

---

## Architecture Overview

### High-Level Layers

```
+------------------------------------------+
|              POPUP (UI)                   |
|  index.html   - view template            |
|  popup.js     - controller, ~2600 lines  |
|  style.css    - styling, ~2250 lines     |
+---------------------+--------------------+
                      |  imports / calls
                      v
+------------------------------------------+
|           SERVICE LAYER                   |
|  ChromeService      - tab/window API     |
|  StorageService     - persistence        |
|  AIProviderService  - unified AI layer   |
|  ├─ ollamaProvider  - Ollama (local)     |
|  ├─ geminiProvider  - Google Gemini      |
|  ├─ openRouterProvider - OpenRouter      |
|  └─ groqProvider    - Groq               |
|  SummaryService     - summary generation |
|  PreferenceService  - learning engine    |
|  ImportManager      - import conflict    |
+---------------------+--------------------+
                      |  chrome.runtime.sendMessage
                      v
+------------------------------------------+
|      BACKGROUND SERVICE WORKER            |
|  - CORS proxy (PROXY_FETCH handler)      |
|  - Origin/Referer header removal via     |
|    declarativeNetRequest                  |
+------------------------------------------+
```

### Data Flow

1. **Init** - `init()` runs on popup open -> `StorageService` loads workspaces -> `PreferenceService` loads/initializes memory -> restores AI settings -> renders workspace list.
2. **Save** - `ChromeService.getCurrentWindowTabs()` -> `StorageService.saveWorkspace()` -> re-render.
3. **Restore** - `StorageService.getWorkspaceById()` -> `ChromeService.restoreWorkspace()` (creates new window with all tabs).
4. **AI Organize** - `ChromeService.getCurrentWindowTabs()` -> `PreferenceService.generatePreferenceHints()` -> `AIProviderService.organizeTabs()` (uses selected provider via `aiProviderService.js`) -> interactive editor modal -> create workspaces + learning.
5. **All AI/API calls** go through `chrome.runtime.sendMessage({type:'PROXY_FETCH',...})` -> service worker performs actual `fetch()` to the selected AI provider (CORS bypass via `declarativeNetRequest`).

### Routing

None. Single popup page. Modal overlays handle import preview and AI organization editing.

### State Management

All state lives in `popup.js` module-scoped variables:
- `cachedWorkspaces` - local mirror of storage for quick sort/search
- `activeConflictReport` - import conflict data
- `activeOrganization` - `{groups, tabs}` during AI organize editing
- `unassignedTabIndices` - tab indices not yet grouped
- `aiOrganizationSnapshot` - original AI output for diff computation
- `undoStack` / `redoStack` - editor history (max 50 entries)
- `collapsedGroups` - `Set` of collapsed group indices
- Various UI state: `tabSearchQuery`, `movePanelState`, `mergeState`, `dragState`, `bulkGenerationState`

Persistence: All data persists via `chrome.storage.local` through `StorageService`.

---

## Data Model

### Workspace Object

Stored in the `tabmind_workspaces` array in `chrome.storage.local`.

```js
{
  id: "ws_<randomUUID>",
  name: "Workspace Name",
  notes: "Optional notes (max 1000 chars)",
  summary: "AI-generated summary or empty string",
  summaryGeneratedAt: 1719000000000 | null,
  summaryStale: false,
  summaryMetadata: {
    model: "qwen3:4b",
    generatedAt: 1719000000000,
    tabCount: 12
  } | null,
  createdAt: 1718900000000,
  updatedAt: 1719000000000,
  tabs: [
    {
      url: "https://example.com/page",
      title: "Page Title",
      favIconUrl: "https://example.com/favicon.ico",
      pinned: false
    }
  ]
}
```

### Preference Memory Object

Stored in `tabmind_preference_memory`.

```js
{
  version: 2,
  enabled: true,
  domainRules: {
    "github.com": {
      preferredWorkspace: "Development",
      category: "development",
      confidence: 0.85,
      observations: 12,
      lastSeen: 1719000000000
    }
  },
  workspacePatterns: {
    "pat_<uuid>": {
      patternId: "pat_<uuid>",
      names: { "Development": 5, "Coding": 2 },
      domains: ["github.com", "stackoverflow.com"],
      categories: ["development"],
      confidence: 0.72,
      frequency: 7,
      lastSeen: 1719000000000
    }
  },
  namingPreferences: {
    "originalName": {
      preferredName: "User's Renamed Version",
      confidence: 0.65,
      observations: 3
    }
  },
  categoryPreferences: {
    "github.com": { category: "development" }
  },
  corrections: [
    {
      id: "corr_<uuid>",
      type: "move" | "rename" | "delete" | "create" | "merge",
      timestamp: 1719000000000,
      data: { }
    }
  ],
  statistics: {
    totalCorrections: 42,
    lastUpdated: 1719000000000,
    lastDecayApplied: 1718900000000
  }
}
```

---

## Features & Technical Implementation

### 5.1 Workspace CRUD

| Feature | Implementation |
|---|---|
| **Save** | `ChromeService.getCurrentWindowTabs()` queries `chrome.tabs.query({currentWindow: true})`, filters out `chrome://`, `about:`, `edge://`, `devtools:` URLs, then `StorageService.saveWorkspace()` appends to the array with a new UUID, timestamps, and empty notes/summary. |
| **Restore** | `ChromeService.restoreWorkspace()` creates a new window with the first tab via `chrome.windows.create()`, then creates remaining tabs via `chrome.tabs.create()`. A second pass applies `pinned` state to avoid Chrome reordering pinned tabs. |
| **Update** | Replaces the `tabs[]` array of an existing workspace, sets `updatedAt` to `Date.now()`, marks `summaryStale: true`. |
| **Delete** | Filters the workspace out of the array. Records a deletion signal to `PreferenceService` (weight: -2). |
| **Duplicate** | Deep-clones workspace tabs, appends " Copy" to name, generates fresh UUID via `crypto.randomUUID()`. |
| **Rename** | `StorageService.renameWorkspace()` updates `name` and `updatedAt`, returns old/new name pair for preference learning (+10). |

**Validation**: Names capped at 100 chars; notes at 1000 chars. Hard limit of 50 workspaces (`config.js` `MAX_WORKSPACES`).

---

### 5.2 Search & Sort

**Search**: Real-time filtering from `cachedWorkspaces` by workspace name and notes (case-insensitive `includes()`). Re-renders on each keystroke without storage fetch.

**Sort**: Six options - Newest/Oldest (by `createdAt`), A-Z/Z-A (by `name`), Most/Least tabs (by `tabs.length`). Sort preference persisted to `chrome.storage.local` as `tabmind_sort_preference`.

---

### 5.3 Statistics & AI Insights

**Statistics Bar**: Total workspace count, total saved tabs, largest workspace, latest workspace name. Computed via `Array.reduce()` over `cachedWorkspaces`.

**AI Insights Panel** (`workspaceInsights.js` pure functions): Summarized/pending/outdated counts, average tabs per workspace. No storage fetches.

**Bulk Summary Generation**: Iterates workspaces without summaries or with stale flag. Calls `generateWorkspaceSummary` sequentially with real-time progress bar. Continues past individual failures.

---

### 5.4 AI-Powered Workspace Summaries

**Trigger**: Per-workspace "Generate Summary" button or bulk "Summarize All".

**Service**: `summaryService.js`

**Prompt Construction**: Includes workspace name, notes, and formatted tab titles + domains. Injects a category detection step (8 categories: communication, development, learning, research, ai_tools, productivity, entertainment, shopping, administration) via hard-coded domain/title regex heuristics. Dominant category guides the LLM.

**Parameters**: `/no_think` directive, `format: 'json'`, `temperature: 0.3`, `num_predict: 512`. Default model: `qwen3:4b`.

**Response Parsing**: Strips `<think>` blocks, code fences, XML tags. Extracts JSON `{summary: "..."}`. Cleans lazy prefixes ("This workspace focuses on..."), deduplicates sentences, enforces 80-word limit.

**Staleness Tracking**: `summaryStale` flag set on tab update; UI shows stale badge. Bulk re-summarize action available.

---

### 5.5 AI Tab Organization (Flagship Feature)

Uses selected AI provider (Ollama, Gemini, OpenRouter, or Groq) to intelligently group current browser tabs into thematic workspaces. Provider can be switched via a dropdown next to the organize button or in the AI settings panel.

#### Full Flow

1. User clicks "Organize Tabs with AI" (provider selected via dropdown).
2. Current window tabs captured via `ChromeService.getCurrentWindowTabs()`.
3. **Rollback safety**: Session auto-saved as "Original Session - <date>" before AI runs.
4. Preference hints fetched from `PreferenceService.generatePreferenceHints()`.
5. Tabs sent to AI provider via `AIProviderService.organizeTabs()`.
6. Response validated - if minor issues (<=20% unassigned tabs), auto-repaired.
7. Interactive editor modal opens.

#### Prompt Engineering (`prompts.js` in `services/providers/`)

- Dynamic group count: `max(2, ceil(tabs/10))` to `min(8, max(3, ceil(tabs/3)))`.
- Instructs no "General/Miscellaneous/Other" groups.
- Tab summaries: `[index] title (domain)` format.
- Parameters: `temperature: 0.3`, `num_predict: 4096`, `format: 'json'`.
- Preference hints appended when available.

#### Response Validation (`validateOrganization`)

1. Validates group count range.
2. Removes invalid, out-of-range, or duplicate tab indices.
3. Removes empty groups.
4. **Auto-fill**: <=20% unassigned tabs auto-assigned to last group.
5. **Retry**: Failed first attempt triggers stricter retry prompt with specific error. After two failures, clear error shown.

#### Interactive Editor (in `popup.js`)

| Feature | Implementation |
|---|---|
| **Editable group names** | Inline `<input>` fields, live-update `activeOrganization` state |
| **Collapse / Expand** | Toggle per group; state stored in `collapsedGroups` Set |
| **Add group** | Creates empty group with default name "New Group N" |
| **Delete group** | Confirmation dialog -> tabs move to "Unassigned" section |
| **Drag & Drop** | Custom implementation using `mousedown`/`mousemove`/`mouseup` with `requestAnimationFrame` auto-scroll near container edges, variable scroll speed, threshold zones |
| **Move Panel** | Click tab or right-arrow -> slide-in panel with tab info, current workspace, searchable target workspace list. Keyboard navigation (arrows, Enter, Tab trap, Escape) |
| **Merge** | Inline picker to merge group into another, with live tab count preview |
| **Undo/Redo** | Full history (max 50), Ctrl+Z / Ctrl+Shift+Z |
| **Tab search** | Filter tabs within editor by title or domain |
| **Duplicate domain detection** | Highlights same-domain tabs appearing in multiple groups |
| **Workspace color dots** | Deterministic color from workspace name hash |

#### Learning from Edits (`confirmOrganization`)

- Computes diff between original AI output and user-edited result.
- Tracks: moved tabs, renamed groups, deleted/created/merged groups.
- Each edit type gets different weight: renames (+10), moves (+15), merges (+12), deletions (-2), accept (+1).
- Shows "Organization Score" (0-100%) with breakdown after confirmation.
- Auto-generates summaries for newly created workspaces (non-blocking).

---

### 5.6 Preference Learning System

Sophisticated user behavior learning in `preferenceService.js`.

#### Memory Structure (v2)

- **domainRules**: Maps domain -> preferred workspace, confidence, category, observations, lastSeen.
- **workspacePatterns**: Tab grouping patterns with Jaccard similarity matching.
- **namingPreferences**: User-renamed workspace patterns.
- **categoryPreferences**: Domain-category associations.
- **corrections**: History of corrections for analysis.

#### Learning Weights (from `config.js`)

| Signal | Weight |
|---|---|
| Workspace rename | +10 |
| Workspace edit | +10 |
| Domain moved between workspaces | +15 |
| Repeat rename | +5 |
| Workspace merge | +12 |
| Repeated pattern | +3 |
| Accept suggestion | +1 |
| Restore | +1 |
| Delete immediate | -2 |
| Reject pattern | -5 |

#### Confidence System

- Initial: 0.50, Min: 0.20, Max: 0.95.
- Decay: 2% every 30 days (`DECAY_FACTOR: 0.98`).
- Jaccard similarity for pattern matching (threshold 0.30).
- Pruning: max 1000 domain rules, 100 workspace patterns, 200 naming preferences, 500 corrections.

#### Preference Hints for AI

Generates context string from high-confidence (>0.60) domain rules, naming preferences, and workspace patterns. Included in Ollama prompt.

#### UI

Panel shows domain/pattern/naming/correction counts. Toggle enable/disable, export, clear memory.

---

### 5.7 Import / Export with Conflict Resolution

**Export**: `StorageService.buildExportData()` creates JSON with version (3), timestamp, workspace count, workspace array, preference memory. Downloaded as `tabmind-backup-YYYY-MM-DD.json`.

**Import**:
1. File selected, JSON parsed and validated.
2. `detectConflicts()` fingerprints each workspace (DJB2 hash of name + notes + sorted URLs).
3. Three conflict types: `EXACT_MATCH` (same fingerprint), `SIMILAR` (same name, different content), `NEW` (no match).
4. Preview modal shows each workspace with per-item resolution selector: Skip / Import / Replace / Keep Both / Duplicate.
5. `executeResolutions()` performs actions as pure data transformation, then `replaceAllWorkspaces()` persists.

---

### 5.8 AI Settings

Multi-provider AI settings panel with provider selection dropdown:

- **Ollama** (local): Configurable endpoint (`http://localhost:11434`) and model (`qwen3:4b`).
- **Gemini**: API key + model (default: `gemini-2.5-flash`, free tier).
- **OpenRouter**: API key + model (default: `google/gemini-2.5-flash`, free tier).
- **Groq**: API key + model (default: `llama-3.3-70b-versatile`, free tier).
- Provider sections show/hide based on selection; fields toggle dynamically.
- Quick provider dropdown next to "Organize Tabs with AI" button for one-click switching.
- "Test Connection" button works with the selected provider.
- Status indicator dot (offline/online/error/testing).
- Settings persisted in `chrome.storage.local` with automatic migration from v4.5 schema.

---

### 5.9 CORS Bypass (Service Worker)

Manifest V3 restricts CORS even with `host_permissions` in popup pages. Solution:
1. `declarativeNetRequest` rule strips `Origin` and `Referer` headers from `localhost`/`127.0.0.1` requests (Ollama checks Origin header), plus allows requests to `generativelanguage.googleapis.com`, `openrouter.ai`, and `api.groq.com`.
2. `chrome.runtime.sendMessage({type:'PROXY_FETCH',...})` routes all AI API calls through the service worker, which performs the actual `fetch()` with proper CORS treatment.
3. All provider implementations (`ollamaProvider.js`, `geminiProvider.js`, `openRouterProvider.js`, `groqProvider.js`) use `proxyFetch()` to route through this mechanism.

---

## Build & Configuration

### package.json Scripts

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  }
}
```

### vite.config.js
- Uses `@crxjs/vite-plugin` to transform `manifest.json` for Chrome Extension.
- Dev server on port 5173 with strict port, HMR on same port.
- No additional Vite plugins.

### Running
1. `npm run dev` - Starts Vite dev server with HMR for extension development.
2. `npm run build` - Builds production bundle to `dist/`.
3. Load unpacked extension in Chrome: `chrome://extensions` -> Developer mode -> Load `dist/` folder.

### Build Output (`dist/`)
- `manifest.json` (modified: service worker path rewritten to `service-worker-loader.js`).
- `service-worker-loader.js` (1 line, imports hashed service worker).
- `assets/service-worker.js-<hash>.js` (bundled service worker).
- `assets/index.html-<hash>.js` (bundled popup JS).
- `assets/index-<hash>.css` (bundled CSS).
- `src/popup/index.html` (processed HTML referencing hashed assets).
- Static assets (icons, logo) copied into `assets/`.

### ESLint
- ES2022, module source type.
- Globals for browser, webextensions, node.
- Warns on unused vars (except `_`-prefixed), console allowed.

---

## Notable Implementation Details

1. **Zero runtime dependencies** - Entire extension is hand-written vanilla JS. No React, Vue, jQuery, lodash, or any runtime npm package.

2. **DJB2 hashing for fingerprinting** - Import conflict detection uses DJB2 hash (simple, fast, non-cryptographic) for workspace fingerprinting instead of deep equality checks.

3. **Rollback safety** - Before AI organization, current session auto-saved as "Original Session" workspace providing a safety net.

4. **Dual retry for AI** - If first LLM response fails validation, stricter retry prompt sent with specific error. After two failures, clear error shown.

5. **Response parsing resilience** - Aggressive cleaning of model artifacts: strips `<think>` blocks (DeepSeek style), code fences, XML tags, extracts JSON from surrounding prose.

6. **Auto-repair of AI output** - Up to 20% unassigned tabs auto-assigned to last group instead of failing.

7. **Diff-based learning** - After AI organization, detailed diff (moved tabs, renamed/deleted/created/merged groups) computed against original AI output. Each edit type gets different learning weight.

8. **Jaccard similarity for pattern matching** - Uses Jaccard index on domain sets plus name bonus (0.3) to match workspace patterns in the preference engine.

9. **Confidence decay** - All learned preferences decay by 2% every 30 days if not reinforced, preventing stale data from persisting indefinitely.

10. **Drag-and-drop with auto-scroll** - Custom `requestAnimationFrame`-based auto-scroll when dragging near container edges, with threshold zones and variable scroll speed.

11. **Slide-in move panel** - Animated slide panel with focus trapping, keyboard navigation (arrows, Enter, Tab, Escape), search filtering with highlighted text, aria attributes.

12. **Category detection heuristics** - 8 predefined categories with domain lists and title pattern regexes for lightweight content classification without AI.

13. **Undo/Redo in editor** - Full command history with max 50 entries. Ctrl+Z / Ctrl+Shift+Z support with visual feedback.

---

## Limitations

- **Max 50 workspaces** hard limit in `config.js`.
- **Max 1000 characters** for workspace notes.
- **Single popup page** - no options page, no separate settings page.
- **No TypeScript** - pure JavaScript with no type safety.
- **No unit tests** in the codebase.
- UI is **380px wide** fixed, scrollable (max-height 600px).
- Cloud AI providers (**Gemini, OpenRouter, Groq**) require an API key.
- **Ollama** requires running locally on `localhost:11434` (configurable).
- **Default Ollama model** is `qwen3:4b`; other providers use best free-tier defaults.
