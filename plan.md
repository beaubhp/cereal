# Locally — Engineering Implementation Guide

## MVP Build Plan for Engineers

This document is the step-by-step build plan for the Locally MVP. Each step is scoped to be implementable independently, in order. Complete each step before moving to the next — later steps depend on earlier ones.

**What we're building:** An Electron macOS app that sits in the menu bar, detects when you're in a meeting (Zoom, Google Meet, Slack), captures audio locally, transcribes it in real-time, and after the meeting generates AI-enhanced notes with summaries, action items, and key decisions — all on-device, nothing sent to the cloud.

**Key architecture decisions already made:**

- Electron app (not native SwiftUI)
- ScreenCaptureKit for audio capture (requires native addon)
- WhisperKit for real-time transcription (requires native addon)
- Pyannote for post-meeting speaker diarization
- Qwen 3.5 9B (Q4_K_M, 5.7 GB) via MLX for summarization
- SQLite + FTS5 for local storage and search
- Single .dmg distribution with all models bundled
- Minimum hardware: Apple Silicon Mac (M1+) with 16 GB RAM

---

## Step 0: Project Scaffolding & Dev Environment

**Goal:** Get the Electron project set up with the build toolchain, native addon support, and basic menu bar app running.

**Tasks:**

1. Initialize Electron project with electron-forge or electron-builder. Use TypeScript for the renderer and main process.
2. Set up the menu bar agent using a Tray icon (electron `Tray` API). The app should launch into the system tray, not as a window. Clicking the tray icon opens a popover window.
3. Configure native addon build toolchain:
   - Install `node-addon-api` or set up `napi-rs` (Rust → Node bindings). We need this because ScreenCaptureKit and WhisperKit are native Swift/ObjC APIs.
   - Set up `node-gyp` or `cmake-js` for compiling native modules.
   - Create a `native/` directory for all Swift/ObjC bridge code.
   - Verify a trivial native addon compiles and is callable from the Electron main process.
4. Set up basic IPC between main process and renderer (we'll use this extensively later).
5. Configure electron-builder for macOS `.dmg` distribution:
   - Code signing setup (Developer ID)
   - Notarization setup (Apple notary service)
   - Set `entitlements.plist` to include `com.apple.security.device.audio-input` and `com.apple.security.device.screen-capture`
6. Create a basic React + Tailwind (or your preferred CSS framework) setup for the renderer UI.

**Output:** A menu bar Electron app that launches on macOS, shows a tray icon, opens a popover window on click, and can call a trivial native addon from the main process.

---

## Step 1: Audio Capture (Native Addon)

**Goal:** Capture microphone audio and system audio simultaneously using ScreenCaptureKit, accessible from the Electron main process.

**Why this is first:** Everything else depends on getting audio. This is the hardest native integration, so tackle it early.

**Tasks:**

1. Build a native addon (Swift/ObjC compiled with node-addon-api or napi-rs) that wraps ScreenCaptureKit:
   - Use `SCShareableContent` to enumerate available audio sources
   - Create an `SCStream` configured for audio-only capture (no video)
   - Configure the stream to capture both system audio and microphone input
   - The `SCStreamConfiguration` should set `capturesAudio = true`, `excludesCurrentProcessAudio = true` (so we don't capture our own app sounds), and `channelCount = 1` (mono, required for Whisper later)
   - Sample rate: 16000 Hz (Whisper's expected input format)

2. Implement a streaming interface that pushes audio chunks from the native addon to the Electron main process:
   - Use `SCStreamDelegate` to receive `CMSampleBuffer` audio data
   - Convert `CMSampleBuffer` to raw PCM Float32 arrays
   - Expose a Node.js readable stream or callback-based API: `audioCapture.start()`, `audioCapture.stop()`, `audioCapture.onAudioChunk(callback)`
   - Separate streams for mic vs. system audio (we need this for "Me" vs. "Others" labeling)

3. Handle macOS permissions:
   - On first launch, the app must request Microphone permission (`AVCaptureDevice.requestAccess(for: .audio)`)
   - Screen Recording permission is required for system audio capture via ScreenCaptureKit. This can't be requested programmatically — direct users to System Settings → Privacy & Security → Screen Recording.
   - Implement a permission check on app launch: if permissions aren't granted, show a clear UI explaining what to enable and why.

4. Implement start/stop recording controls:
   - `startCapture()` — begins both mic and system audio streams
   - `stopCapture()` — ends both streams, cleans up resources
   - Expose recording state to the renderer via IPC

**Testing:** Record a 30-second audio clip from a test Zoom call. Verify you get two separate PCM streams (mic and system). Save them as .wav files and play them back to confirm quality and separation.

**Key technical notes:**
- ScreenCaptureKit requires macOS 12.3+. This is fine since we're Apple Silicon only (M1 shipped with macOS 11, all now on 12+).
- The native addon must be compiled as a universal binary (arm64) for Apple Silicon.
- Audio buffers should be kept in memory only — never written to disk. This is a core privacy guarantee.

---

## Step 2: Real-Time Transcription (Native Addon)

**Goal:** Feed the captured audio streams into WhisperKit and get real-time text transcription back in the Electron main process.

**Tasks:**

1. Build a second native addon (or extend the audio capture addon) that wraps WhisperKit:
   - WhisperKit is a Swift package: https://github.com/argmaxinc/WhisperKit
   - Add WhisperKit as a Swift Package Manager dependency in the native addon's build
   - Use the `large-v3` model (~3 GB). This will be bundled with the app.

2. Implement a streaming transcription pipeline:
   - Accept PCM Float32 audio chunks from the audio capture addon
   - Feed chunks to WhisperKit's streaming transcription API
   - WhisperKit supports streaming inference with word-level timestamps
   - Return transcription segments as they're produced: `{ text: string, startTime: number, endTime: number, isMe: boolean }`
   - `isMe` is determined by which audio stream the chunk came from (mic = true, system = false)

3. Expose to Electron main process:
   - `transcriber.loadModel(modelPath)` — load the Whisper model from bundled resources
   - `transcriber.startTranscription()` — begin processing audio chunks
   - `transcriber.onSegment(callback)` — fires for each transcribed segment
   - `transcriber.stopTranscription()` — stop and clean up

4. Wire audio capture → transcription:
   - In the Electron main process, pipe audio chunks from Step 1 into the transcriber from Step 2
   - Both mic and system audio should be transcribed, with `isMe` flag set accordingly
   - Handle the case where both streams produce audio simultaneously (common in real meetings)

5. Bundle the Whisper model:
   - The `large-v3` model files (~3 GB) must be included in the app bundle
   - Place them in `Contents/Resources/models/whisper-large-v3/`
   - The native addon should accept a path to the model directory

**Testing:** Join a test Google Meet call. Start capture + transcription. Verify you get live text segments with correct `isMe` attribution. Verify latency is under 2 seconds from speech to text appearance. Verify CPU/memory usage stays reasonable (should be ~2-3 GB RAM for WhisperKit).

**Key technical notes:**
- WhisperKit is optimized for Apple Neural Engine. It will automatically use ANE + GPU via Metal.
- The model loads once at transcription start and stays in memory until stopped.
- Audio that's too quiet or is silence should be handled gracefully (voice activity detection is built into WhisperKit).

---

## Step 3: Meeting Detection

**Goal:** Automatically detect when the user is in a Zoom, Google Meet, or Slack huddle and prompt them to record.

**Tasks:**

1. Build a meeting detection service in the Electron main process:
   - Poll running applications every 5 seconds using a lightweight native call or `child_process.execSync('ps aux')` / `osascript` to check for known meeting app processes
   - Detect by bundle ID:
     - Zoom: `us.zoom.xos`
     - Slack: `com.tinyspeck.slackmacgap`
     - Google Meet: runs in browser — detect by checking if Chrome/Arc/Safari/Firefox/Edge has an active audio output (or check window titles for "meet.google.com")
   - For browser-based meetings (Google Meet), consider using ScreenCaptureKit's `SCShareableContent.getWithCompletionHandler` to enumerate windows and check titles for "Meet" URLs
   - Track state transitions: `idle` → `meeting_detected` → `recording` → `processing` → `idle`

2. Implement the notification/prompt flow:
   - When a meeting is detected for the first time, show a macOS notification using Electron's `Notification` API: "Looks like you're in a meeting. Record?"
   - Notification actions: "Yes" / "No" / "Always for this app"
   - If "Yes" → start audio capture + transcription immediately
   - If "Always" → persist this preference per app (e.g., always record Zoom calls). Store in electron-store or a local preferences file.
   - If "No" → dismiss, don't ask again for this meeting session (until meeting ends and a new one starts)

3. Detect meeting end:
   - If the meeting app process disappears, or the audio stream goes silent for >60 seconds, consider the meeting ended
   - Transition to `processing` state (triggers post-meeting pipeline in later steps)

4. Update the tray icon to reflect state:
   - Idle: default icon
   - Meeting detected (not recording): pulsing/attention icon
   - Recording: red dot or recording indicator
   - Processing: spinner or processing indicator

**Testing:** Join and leave Zoom, Google Meet (in Chrome), and Slack huddles. Verify detection fires within 10 seconds of joining. Verify end detection fires within 60 seconds of leaving. Verify notification appears and actions work.

**Key technical notes:**
- Google Meet detection is the trickiest because it's browser-based. Window title matching is the most reliable approach. The title typically contains "Meet - " or the meeting URL.
- Don't over-poll. 5-second intervals are sufficient and have negligible CPU impact.
- Store the "Always" preference in `electron-store` keyed by app bundle ID.

---

## Step 4: Local Data Storage

**Goal:** Set up SQLite database for storing meeting transcripts, metadata, and notes. Implement full-text search.

**Tasks:**

1. Install `better-sqlite3` (synchronous SQLite for Node.js — works well in Electron main process):
   ```
   npm install better-sqlite3
   ```

2. Create the database schema:

   ```sql
   CREATE TABLE meetings (
     id TEXT PRIMARY KEY,        -- UUID
     title TEXT,                  -- auto-generated or user-edited
     started_at TEXT NOT NULL,    -- ISO 8601
     ended_at TEXT,               -- ISO 8601
     duration_seconds INTEGER,
     detected_app TEXT,           -- 'zoom', 'google-meet', 'slack'
     template TEXT DEFAULT 'general',  -- 'general', 'standup', '1on1', 'interview'
     created_at TEXT NOT NULL
   );

   CREATE TABLE transcript_segments (
     id TEXT PRIMARY KEY,
     meeting_id TEXT NOT NULL,
     speaker TEXT NOT NULL,       -- 'me' or 'speaker-1', 'speaker-2', etc.
     speaker_label TEXT,          -- user-assigned name, nullable
     text TEXT NOT NULL,
     start_time_ms INTEGER NOT NULL,
     end_time_ms INTEGER NOT NULL,
     is_me BOOLEAN NOT NULL DEFAULT 0,
     FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
   );

   CREATE TABLE meeting_notes (
     id TEXT PRIMARY KEY,
     meeting_id TEXT NOT NULL UNIQUE,
     summary TEXT,                -- AI-generated summary (markdown)
     action_items TEXT,           -- JSON array of action items
     key_decisions TEXT,          -- JSON array of decisions
     key_quotes TEXT,             -- JSON array of quotes with speaker + timestamp
     raw_llm_output TEXT,         -- full LLM response for debugging
     template_used TEXT,
     created_at TEXT NOT NULL,
     FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
   );

   -- Full-text search index on transcript content
   CREATE VIRTUAL TABLE transcript_fts USING fts5(
     text,
     content=transcript_segments,
     content_rowid=rowid
   );

   -- Triggers to keep FTS in sync
   CREATE TRIGGER transcript_ai AFTER INSERT ON transcript_segments BEGIN
     INSERT INTO transcript_fts(rowid, text) VALUES (new.rowid, new.text);
   END;

   CREATE TRIGGER transcript_ad AFTER DELETE ON transcript_segments BEGIN
     INSERT INTO transcript_fts(transcript_fts, rowid, text) VALUES('delete', old.rowid, old.text);
   END;

   -- Full-text search on notes
   CREATE VIRTUAL TABLE notes_fts USING fts5(
     summary,
     content=meeting_notes,
     content_rowid=rowid
   );
   ```

3. Build a data access layer (DAL) module:
   - `createMeeting(metadata)` → returns meeting ID
   - `addTranscriptSegment(meetingId, segment)` → inserts a segment
   - `addTranscriptSegmentsBatch(meetingId, segments[])` → bulk insert for post-meeting diarization
   - `saveMeetingNotes(meetingId, notes)` → insert/update notes
   - `getMeeting(id)` → full meeting with transcript + notes
   - `listMeetings(opts?)` → paginated list, most recent first
   - `searchMeetings(query)` → FTS5 search across transcripts and notes, returns ranked results
   - `updateSpeakerLabel(meetingId, speaker, label)` → rename "speaker-1" to "Greg"
   - `deleteMeeting(id)` → cascade delete meeting + segments + notes

4. Database location:
   - Default: `~/Library/Application Support/Locally/data.sqlite`
   - Create the directory on first launch if it doesn't exist
   - This path persists across app updates

**Testing:** Write unit tests for the DAL. Insert 100 fake meetings with transcripts. Verify FTS5 search returns correct results for keyword queries. Verify cascade delete works.

---

## Step 5: Post-Meeting Speaker Diarization

**Goal:** After a meeting ends, run Pyannote speaker diarization on the recorded audio to distinguish individual speakers beyond "Me" vs. "Others."

**Tasks:**

1. Set up a Python subprocess environment:
   - Bundle a minimal Python 3.11+ runtime with the app (or use the system Python if available on macOS)
   - Preferred approach: bundle a self-contained Python virtualenv in the app resources with Pyannote pre-installed
   - Alternative: use `pyinstaller` to create a standalone diarization binary that the Electron app calls
   - Install dependencies: `pyannote.audio`, `torch`, `torchaudio`

2. Build the diarization script (`diarize.py`):
   ```
   Input: path to a temporary WAV file of system audio (the "Others" stream only)
   Output: JSON array of segments with speaker labels and timestamps
   ```
   - Load the `pyannote/speaker-diarization-3.1` pipeline (download model on first run, cache in app support directory)
   - Run diarization on the audio file
   - Output format:
     ```json
     [
       { "speaker": "speaker-1", "start_ms": 0, "end_ms": 15000 },
       { "speaker": "speaker-2", "start_ms": 15200, "end_ms": 32000 },
       ...
     ]
     ```

3. Wire into the post-meeting pipeline:
   - When a meeting ends (Step 3 detects meeting end):
     - Save the system audio buffer to a temporary WAV file (this is the ONLY time audio touches disk, and it's deleted immediately after diarization)
     - Spawn the Python diarization subprocess
     - Parse the JSON output
     - Merge diarization results with the raw transcript segments from Step 2:
       - For each transcript segment from the "Others" stream, match it to the closest diarization segment by timestamp overlap
       - Relabel from generic "others" to "speaker-1", "speaker-2", etc.
     - Delete the temporary WAV file
     - Save the relabeled transcript segments to SQLite (Step 4)

4. Handle edge cases:
   - Very short meetings (<2 min): skip diarization, just use "Me" / "Others"
   - Diarization failure: fall back to "Me" / "Others" labeling
   - Single other speaker: don't bother with diarization — it's just "Me" and "Them"

**Key technical notes:**
- The temporary WAV file is the only point where audio touches disk. It must be securely deleted (overwritten) after diarization completes.
- Pyannote model download (~1 GB) happens on first use. Show a progress indicator.
- Diarization takes roughly 1/10th of the meeting duration (a 60-min meeting diarizes in ~6 min on M1). This runs in background.
- The Pyannote model should be cached in `~/Library/Application Support/Locally/models/pyannote/`

---

## Step 6: AI Summarization (Local LLM)

**Goal:** After a meeting ends and diarization completes, run the transcript through Qwen 3.5 9B locally to generate structured meeting notes.

**Tasks:**

1. Set up MLX inference:
   - Option A (recommended): Use `mlx-lm` Python package. Bundle it in the same Python environment as Pyannote (Step 5). This is the fastest path.
   - Option B: Use `llama.cpp` with the GGUF quantized model via a Node.js binding like `node-llama-cpp`. Slightly slower than MLX but avoids Python for this step.
   - We recommend Option A for best performance on Apple Silicon.

2. Bundle the model:
   - Download Qwen 3.5 9B Q4_K_M (~5.7 GB) in MLX format from `mlx-community` on Hugging Face
   - Bundle in `Contents/Resources/models/qwen-3.5-9b-q4/`
   - The model loads into memory when needed and is unloaded after summarization completes

3. Build the summarization script (`summarize.py`):
   - Input: full transcript as text (with speaker labels and timestamps) + selected template name
   - Output: JSON with structured notes

   ```
   Input format (passed via stdin or temp file):
   {
     "transcript": "...",
     "template": "general",
     "meeting_title": "Weekly Standup"
   }

   Output format:
   {
     "summary": "markdown string with 3-5 bullet points",
     "action_items": [
       { "text": "Greg to send API docs by Friday", "assignee": "Greg", "deadline": "Friday" }
     ],
     "key_decisions": [
       { "text": "We'll use Postgres instead of MongoDB", "context": "..." }
     ],
     "key_quotes": [
       { "text": "I think we're overthinking this", "speaker": "speaker-2", "timestamp_ms": 145000 }
     ]
   }
   ```

4. Implement prompt templates for each meeting type. These are the system prompts passed to the LLM:

   **General Meeting:**
   ```
   You are a meeting note assistant. Given the following meeting transcript, produce structured notes.

   Output a JSON object with these fields:
   - "summary": 3-5 bullet points covering the main topics (markdown string)
   - "action_items": array of { "text", "assignee" (if mentioned), "deadline" (if mentioned) }
   - "key_decisions": array of { "text", "context" }
   - "key_quotes": array of { "text", "speaker", "timestamp_ms" } — 2-3 notable statements

   Be concise. Use the speaker labels as-is. Only include action items that were explicitly stated or strongly implied.
   ```

   **Standup:**
   ```
   You are a standup meeting assistant. Given the transcript, extract per-person updates.

   Output JSON:
   - "summary": per-person updates (what they did, what they're doing)
   - "action_items": array of follow-ups or blockers with assignee
   - "key_decisions": any decisions made
   - "key_quotes": skip this field for standups
   ```

   **1:1 Meeting:**
   ```
   You are a 1:1 meeting assistant. Given the transcript, extract discussion topics and commitments.

   Output JSON:
   - "summary": main topics discussed (markdown bullets)
   - "action_items": commitments made by either party
   - "key_decisions": any decisions or agreements reached
   - "key_quotes": notable feedback or insights (2-3 max)
   ```

   **Interview / Discovery Call:**
   ```
   You are a user research assistant. Given the transcript, extract insights and pain points.

   Output JSON:
   - "summary": key insights and takeaways (markdown bullets)
   - "action_items": follow-up questions or things to investigate
   - "key_decisions": replace this with "pain_points" — array of { "text", "context" }
   - "key_quotes": direct quotes that capture user sentiment (3-5)
   ```

5. Wire into the post-meeting pipeline:
   - After diarization (Step 5) completes and transcript segments are saved to SQLite:
     - Load the full transcript from SQLite
     - Format it as timestamped text with speaker labels
     - Spawn the summarization subprocess
     - Parse JSON output
     - Save to `meeting_notes` table in SQLite
     - Send notification: "Your notes for '{meeting_title}' are ready"

6. Error handling:
   - If the LLM produces invalid JSON, retry once with a stricter prompt
   - If it fails again, save the raw text output and flag the notes as "needs review"
   - Set a timeout of 120 seconds (if it takes longer than this on M1, something is wrong)

**Key technical notes:**
- Qwen 3.5 9B with MLX on M1 16GB: ~30-50 tok/s. A typical meeting transcript (5,000 tokens input, 500 tokens output) takes 15-25 seconds.
- The 262K context window means we never need to chunk transcripts. Even a 3-hour meeting fits.
- Use `"think": false` mode (non-reasoning) for faster, more direct output. Reasoning mode is overkill for summarization.
- The model uses ~6 GB RAM when loaded. It should be loaded on-demand and unloaded after each summarization to free memory.

---

## Step 7: Meeting Notes UI (Renderer)

**Goal:** Build the main app UI — the notes view that users see after a meeting is processed, and the meeting library for browsing past meetings.

**Tasks:**

1. **Meeting Library (Home View):**
   - This is the default view when the user clicks the tray icon
   - Chronological list of meetings, most recent first
   - Each row shows: meeting title, date/time, duration, number of speakers, detected app icon (Zoom/Meet/Slack)
   - Search bar at the top: queries SQLite FTS5 across transcripts and notes
   - Clicking a meeting opens the Notes View

2. **Notes View (Single Meeting):**
   - Top section: meeting metadata (title — editable, date, duration, participants)
   - Template selector: dropdown to switch between General / Standup / 1:1 / Interview. Changing template re-runs summarization.
   - Notes body with collapsible sections:
     - **Summary** — rendered markdown
     - **Action Items** — checklist style (checkboxes for tracking, though state is local only)
     - **Key Decisions** — simple list
     - **Key Quotes** — each quote shows speaker label and timestamp. Clicking the timestamp scrolls to that point in the transcript.
   - **Full Transcript** — scrollable section below the notes:
     - Each segment shows: speaker label (colored), timestamp, text
     - Speaker labels are clickable to rename (e.g., click "Speaker 1" → type "Greg" → all instances update)
     - "Me" segments styled differently from others (e.g., right-aligned or different background)
   - Edit button: allow users to manually edit the summary, add/remove action items

3. **UI Framework & Styling:**
   - Use React in the renderer process
   - Style with Tailwind CSS or a minimal CSS approach
   - Keep it clean and minimal — think Linear or Apple Notes aesthetic
   - Use a monospace or clean sans-serif font for transcripts
   - Dark mode support (respect macOS system setting via `prefers-color-scheme`)

4. **IPC Communication:**
   - Renderer ↔ Main process communication via Electron IPC:
     - `get-meetings` → returns paginated meeting list
     - `get-meeting(id)` → returns full meeting data (metadata + transcript + notes)
     - `search-meetings(query)` → returns FTS results
     - `update-meeting-title(id, title)` → update title
     - `update-speaker-label(meetingId, speaker, label)` → rename speaker
     - `rerun-summarization(meetingId, template)` → re-summarize with different template
     - `delete-meeting(id)` → delete meeting and all associated data
   - Real-time updates during recording:
     - `recording-status` → current state (idle/recording/processing)
     - `new-transcript-segment` → pushed from main to renderer during live recording
     - `processing-complete` → meeting notes are ready

5. **Live Transcript View (during meeting):**
   - When recording is active, show a minimal live transcript view
   - Segments appear in real-time as WhisperKit produces them
   - Auto-scroll to bottom
   - Show "Me" vs. "Others" with simple labeling
   - This view is optional — users can keep the app closed and just let it record in the background

**Key technical notes:**
- Keep the renderer lightweight. All heavy work (audio, transcription, LLM) happens in the main process or subprocesses.
- Use `electron-store` for user preferences (auto-record settings, window position, etc.).
- The popover window should be resizable. Default size: ~400px wide, ~600px tall for the library view; wider for the notes view.

---

## Step 8: Settings & Preferences

**Goal:** Build the settings UI and implement user-configurable preferences.

**Tasks:**

1. **Settings Panel** (accessible from tray icon menu or within the app):
   - **Permissions status:** Show green/red indicators for Microphone and Screen Recording permissions. Link to System Settings if not granted.
   - **Auto-record preferences:**
     - Global default: "Always" / "Never" / "Ask each time"
     - Per-app overrides: e.g., "Always record Zoom, ask for Slack"
   - **Storage:**
     - Show current database size
     - Show storage location (default path, not user-configurable in v1)
     - "Delete all data" button with confirmation
   - **Optional: Cloud API key:**
     - Text input for OpenAI or Anthropic API key
     - When set, summarization uses the cloud LLM instead of local Qwen
     - Clear warning label: "When enabled, your transcript text will be sent to [provider] for summarization. Audio is never sent."
     - This is a secondary feature — local is the default and recommended path

2. **Persist preferences** using `electron-store`:
   ```json
   {
     "autoRecord": "ask",
     "autoRecordOverrides": {
       "us.zoom.xos": "always",
       "com.tinyspeck.slackmacgap": "ask"
     },
     "cloudApiKey": null,
     "cloudProvider": null,
     "launchAtLogin": true
   }
   ```

3. **Launch at login:**
   - Toggle in settings
   - Use Electron's `app.setLoginItemSettings()` to register/unregister

---

## Step 9: Post-Meeting Pipeline Orchestration

**Goal:** Wire all the pieces together into a reliable end-to-end pipeline that triggers when a meeting ends.

This step is about integration, not new features. The components from Steps 1-8 need to work together seamlessly.

**Pipeline sequence:**

```
Meeting ends (detected by Step 3)
  │
  ├─ 1. Stop audio capture (Step 1)
  ├─ 2. Stop live transcription (Step 2)
  ├─ 3. Save raw transcript segments to SQLite (Step 4)
  │
  ├─ 4. Write system audio to temp WAV file
  ├─ 5. Run Pyannote diarization (Step 5)
  ├─ 6. Merge diarization results with transcript segments
  ├─ 7. Update transcript segments in SQLite with speaker labels
  ├─ 8. Delete temp WAV file (secure delete)
  │
  ├─ 9. Load full transcript from SQLite
  ├─ 10. Run Qwen 3.5 9B summarization (Step 6)
  ├─ 11. Save meeting notes to SQLite
  │
  └─ 12. Show macOS notification: "Your notes are ready"
       └─ Click notification → open notes view for this meeting
```

**Tasks:**

1. Implement a `PostMeetingPipeline` class in the Electron main process:
   - Accepts a meeting ID and the raw audio buffers
   - Runs steps 4-12 sequentially
   - Emits progress events to the renderer: "Diarizing speakers..." → "Generating notes..." → "Done"
   - Handles errors at each step gracefully (if diarization fails, skip to summarization with basic labels)

2. Implement a processing queue:
   - If the user finishes one meeting and immediately starts another, the first meeting's processing should continue in the background
   - Use a simple FIFO queue — process one meeting at a time

3. Audio buffer management:
   - During recording, audio chunks are accumulated in memory (in the main process)
   - The mic stream and system stream are kept separate
   - After recording stops, the system audio buffer is written to a temp file for diarization only
   - After diarization, the temp file is deleted and all audio buffers are freed
   - At no point is audio persisted permanently

4. Notification handling:
   - Use Electron's `Notification` API for the "notes ready" notification
   - Clicking the notification should focus the app and navigate to the meeting's notes view
   - Use IPC to tell the renderer which meeting to display

**Testing:** Run through the full flow end-to-end:
1. Start a test Zoom call
2. Verify meeting detection triggers
3. Accept the recording prompt
4. Talk for 2-3 minutes with at least 2 speakers
5. End the call
6. Verify the post-meeting pipeline runs automatically
7. Verify notification appears
8. Click notification, verify notes view shows summary + action items + transcript with speaker labels
9. Verify no audio files remain on disk

---

## Step 10: App Bundling & Distribution

**Goal:** Package the app as a single `.dmg` with all models bundled, ready for installation.

**Tasks:**

1. **Bundle all models in the app package:**
   - WhisperKit large-v3 model (~3 GB) → `Contents/Resources/models/whisper/`
   - Qwen 3.5 9B Q4_K_M (~5.7 GB) → `Contents/Resources/models/qwen/`
   - Pyannote speaker-diarization model (~1 GB) → downloaded on first use and cached in `~/Library/Application Support/Locally/models/pyannote/` (bundling this adds too much to the initial download; downloading on first use with a progress bar is better)

2. **Total app size:** ~9-10 GB (Whisper + Qwen bundled, Pyannote downloaded separately)
   - This is large but acceptable for an app that replaces cloud services
   - Consider offering a "lite" download (~4 GB) that downloads the LLM model on first launch

3. **Python runtime bundling:**
   - Use PyInstaller or cx_Freeze to create standalone binaries for the diarization and summarization scripts
   - These binaries include the Python runtime and all dependencies — no system Python required
   - Place in `Contents/Resources/bin/diarize` and `Contents/Resources/bin/summarize`
   - This eliminates the need for users to install Python

4. **electron-builder configuration:**
   - Target: `dmg` for macOS
   - Architecture: `arm64` only (Apple Silicon)
   - Code sign with Developer ID Application certificate
   - Notarize with Apple (required for apps distributed outside the App Store)
   - Set `hardened-runtime` to `true`
   - Include entitlements for audio input and screen capture

5. **Auto-updates:**
   - Integrate Sparkle framework (via `electron-updater` or native Sparkle integration)
   - Host update feed on a simple server or GitHub Releases
   - Check for updates on launch (non-blocking)

6. **First-launch experience:**
   - On first launch, show a simple onboarding flow:
     - Screen 1: "Locally keeps your meeting notes private. Everything runs on your Mac."
     - Screen 2: "Grant permissions" — guide user to enable Microphone and Screen Recording
     - Screen 3: "You're all set" — app is now running in the menu bar
   - If Pyannote model isn't downloaded yet, show a one-time download progress bar: "Downloading speaker identification model (1 GB)..."

**Testing:** Build the DMG. Install on a clean Mac (no dev tools). Verify:
- App launches from Applications folder
- Onboarding flow works
- Permissions prompt correctly
- First meeting records and processes successfully
- Models load correctly from bundled paths
- Pyannote model downloads on first use
- Auto-update check works (even if no update available)

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Electron Main Process                    │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Tray Agent   │  │  Meeting     │  │  Post-Meeting     │  │
│  │  & Notifs     │  │  Detector    │  │  Pipeline         │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Audio       │  │  Transcriber │  │  SQLite DAL       │  │
│  │  Capture     │  │  (WhisperKit)│  │  (better-sqlite3) │  │
│  │  (native)    │  │  (native)    │  │                   │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
│         │                  │                                 │
│    Native Addons (Swift/ObjC compiled with node-addon-api)   │
│         │                  │                                 │
│  ┌──────┴──────────────────┴───────────────────────────────┐ │
│  │  macOS APIs: ScreenCaptureKit, AVFoundation, EventKit   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐                         │
│  │  Pyannote    │  │  MLX + Qwen  │  ← Python subprocesses  │
│  │  (diarize)   │  │  (summarize) │    (bundled binaries)    │
│  └──────────────┘  └──────────────┘                         │
│                                                              │
├──────────────────── IPC (contextBridge) ─────────────────────┤
│                                                              │
│                    Electron Renderer Process                  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Meeting     │  │  Notes View  │  │  Live Transcript  │  │
│  │  Library     │  │              │  │  View             │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
│                                                              │
│  React + Tailwind CSS                                        │
└─────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
locally/
├── package.json
├── electron-builder.yml
├── entitlements.plist
├── src/
│   ├── main/                        # Electron main process
│   │   ├── index.ts                 # Entry point
│   │   ├── tray.ts                  # Menu bar tray agent
│   │   ├── ipc.ts                   # IPC handlers
│   │   ├── meeting-detector.ts      # Meeting detection service
│   │   ├── audio-capture.ts         # JS wrapper around native addon
│   │   ├── transcriber.ts           # JS wrapper around native addon
│   │   ├── post-meeting-pipeline.ts # Orchestrates diarization + summarization
│   │   ├── database.ts              # SQLite DAL (better-sqlite3)
│   │   └── preferences.ts           # electron-store wrapper
│   │
│   ├── renderer/                    # Electron renderer (React app)
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── MeetingLibrary.tsx   # Home view, meeting list + search
│   │   │   ├── MeetingNotes.tsx     # Single meeting notes view
│   │   │   ├── LiveTranscript.tsx   # During-meeting live transcript
│   │   │   └── Settings.tsx         # Settings panel
│   │   ├── components/
│   │   │   ├── TranscriptSegment.tsx
│   │   │   ├── ActionItemList.tsx
│   │   │   ├── SpeakerLabel.tsx
│   │   │   ├── SearchBar.tsx
│   │   │   └── TemplateSelector.tsx
│   │   └── hooks/
│   │       ├── useIPC.ts            # IPC communication hook
│   │       └── useRecordingStatus.ts
│   │
│   └── native/                      # Native addons (Swift/ObjC)
│       ├── audio-capture/
│       │   ├── binding.gyp
│       │   ├── AudioCapture.swift   # ScreenCaptureKit wrapper
│       │   └── AudioCaptureAddon.mm # Node addon bridge
│       └── transcriber/
│           ├── binding.gyp
│           ├── Transcriber.swift    # WhisperKit wrapper
│           └── TranscriberAddon.mm  # Node addon bridge
│
├── python/                          # Python components
│   ├── diarize.py                   # Pyannote speaker diarization
│   ├── summarize.py                 # MLX + Qwen summarization
│   └── requirements.txt
│
├── resources/
│   ├── models/
│   │   ├── whisper/                 # WhisperKit large-v3 (~3 GB)
│   │   └── qwen/                   # Qwen 3.5 9B Q4_K_M (~5.7 GB)
│   ├── icons/
│   │   ├── tray-idle.png
│   │   ├── tray-recording.png
│   │   └── tray-processing.png
│   └── onboarding/                  # First-launch screens
│
└── scripts/
    ├── build-native.sh              # Compile native addons
    ├── bundle-python.sh             # PyInstaller bundling
    └── download-models.sh           # Download models for dev
```

---

## Development Order Summary

| Step | What | Depends On | Estimated Effort |
|------|------|------------|-----------------|
| 0 | Project scaffolding, Electron + native addon toolchain | Nothing | 3-4 days |
| 1 | Audio capture (ScreenCaptureKit native addon) | Step 0 | 5-7 days |
| 2 | Real-time transcription (WhisperKit native addon) | Step 0, Step 1 | 5-7 days |
| 3 | Meeting detection (process monitoring + notifications) | Step 0 | 2-3 days |
| 4 | SQLite database + data access layer | Step 0 | 2-3 days |
| 5 | Post-meeting speaker diarization (Pyannote) | Step 1, Step 4 | 4-5 days |
| 6 | AI summarization (Qwen 3.5 9B via MLX) | Step 4 | 3-4 days |
| 7 | Meeting notes UI (React renderer) | Step 4 | 5-7 days |
| 8 | Settings & preferences | Step 0, Step 7 | 1-2 days |
| 9 | Pipeline orchestration (wire it all together) | Steps 1-8 | 3-5 days |
| 10 | Bundling & distribution (.dmg with models) | Steps 1-9 | 3-5 days |

**Total estimated effort: 6-9 weeks** for a single engineer, or 3-5 weeks with two engineers working in parallel (Steps 1+2 can be parallelized with Steps 3+4, and Step 7 can start once Step 4 is done).

**Parallelization opportunities:**
- Engineer A: Steps 1 → 2 → 5 → 9 (audio pipeline)
- Engineer B: Steps 3 → 4 → 6 → 7 → 8 (detection, data, AI, UI)
- Together: Step 10 (bundling)
