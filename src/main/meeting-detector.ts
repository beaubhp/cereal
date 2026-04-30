import { Notification } from 'electron'
import * as audioCapture from './audio-capture'
import type { MicEventListener } from './audio-capture'
import { getMeetingPref, setMeetingPref } from './meeting-prefs'
import type {
  MeetingDetectionState,
  MeetingInfo,
  MeetingDetectionEvent,
  MeetingPromptResponse
} from '../shared/ipc-types'

// Known native meeting apps — mic active = in a meeting
const KNOWN_MEETING_APPS: Record<string, string> = {
  'us.zoom.xos': 'Zoom',
  'com.microsoft.teams2': 'Microsoft Teams',
  'com.microsoft.teams': 'Microsoft Teams',
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.apple.FaceTime': 'FaceTime',
  'com.hnc.Discord': 'Discord',
  'com.webex.meetingmanager': 'Webex'
}

// Browser bundle IDs — need Layer 2 (window title matching) to identify the service
const BROWSER_BUNDLE_IDS: Record<string, string> = {
  'com.google.Chrome': 'Chrome',
  'com.apple.Safari': 'Safari',
  'company.thebrowser.Browser': 'Arc',
  'org.mozilla.firefox': 'Firefox',
  'com.microsoft.edgemac': 'Edge',
  'com.brave.Browser': 'Brave',
  'com.operasoftware.Opera': 'Opera',
  'com.vivaldi.Vivaldi': 'Vivaldi'
}

// Window title patterns for browser-based meeting services
const WINDOW_TITLE_PATTERNS: Array<{ pattern: RegExp; service: string }> = [
  { pattern: /^Meet\s[–-]\s/, service: 'Google Meet' },
  { pattern: /Microsoft Teams/i, service: 'Microsoft Teams' },
  { pattern: /Zoom/i, service: 'Zoom' },
  { pattern: /Webex|Cisco Webex/i, service: 'Webex' }
]

const GRACE_PERIOD_MS = 30_000
// If the mic was off longer than this before reactivating, treat the rejoin as a
// real "left and came back" rather than a mute toggle / network blip.
const REPROMPT_THRESHOLD_MS = 5_000

// Strip helper suffixes so child processes (e.g. "com.tinyspeck.slackmacgap.helper")
// resolve to their parent app's bundle ID
function normalizeBundleId(bundleId: string): string {
  return bundleId
    .replace(/\.helper(\.[a-z]+)?$/i, '')
    .replace(/\.Helper(\s+\([^)]+\))?$/i, '')
}

type EventListener = (event: MeetingDetectionEvent) => void
type StateListener = (state: MeetingDetectionState) => void
type RecordingRequestListener = (meeting: MeetingInfo) => void

class MeetingDetectorService {
  private state: MeetingDetectionState = 'idle'
  private currentMeeting: MeetingInfo | null = null
  private micEventUnsubscribe: (() => void) | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private userResponded = false
  private lastMicDeactivationTime: number | null = null
  // Bundle IDs whose mic is currently active. Updated synchronously in
  // handleMicEvent so async identification (queryBrowserWindows) can detect
  // a deactivation that happened during its await and bail before pinning a
  // phantom meeting.
  private readonly activeMicBundleIds = new Set<string>()

  private readonly eventListeners = new Set<EventListener>()
  private readonly stateListeners = new Set<StateListener>()
  private readonly recordingRequestListeners = new Set<RecordingRequestListener>()

  start(): void {
    if (this.micEventUnsubscribe) return

    // Subscribe before starting the native monitor — already-active processes
    // are reported on the first poll
    this.micEventUnsubscribe = audioCapture.onMicEvent(this.handleMicEvent)

    try {
      audioCapture.startMeetingMonitor()
    } catch (err) {
      this.micEventUnsubscribe()
      this.micEventUnsubscribe = null
      console.error('Failed to start meeting monitor:', err)
    }
  }

  stop(): void {
    audioCapture.stopMeetingMonitor()

    if (this.micEventUnsubscribe) {
      this.micEventUnsubscribe()
      this.micEventUnsubscribe = null
    }

    this.clearGraceTimer()
    this.activeMicBundleIds.clear()

    if (this.currentMeeting) {
      this.emitEvent({ type: 'meeting-ended', meeting: this.currentMeeting })
      this.currentMeeting = null
    }

    this.setState('idle')
  }

  getState(): MeetingDetectionState {
    return this.state
  }

  getCurrentMeeting(): MeetingInfo | null {
    return this.currentMeeting
  }

  setRecording(): void {
    if (this.state === 'meeting-detected') {
      this.setState('recording')
    }
  }

  respondToPrompt(response: MeetingPromptResponse): void {
    if (!this.currentMeeting) return

    const meeting = this.currentMeeting
    this.userResponded = true

    if (response === 'always' || response === 'never') {
      setMeetingPref(meeting.bundleId, response)
    }

    if (response === 'yes' || response === 'always') {
      this.emitRecordingRequest(meeting)
    }
  }

  onMeetingEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onRecordingRequest(listener: RecordingRequestListener): () => void {
    this.recordingRequestListeners.add(listener)
    return () => this.recordingRequestListeners.delete(listener)
  }

  // --- Private ---

  private handleMicEvent: MicEventListener = (event) => {
    if (event.micActive) {
      this.activeMicBundleIds.add(event.bundleId)
      this.handleMicActivated(event.bundleId).catch((err) => {
        console.error('Meeting detection error:', err)
      })
    } else {
      this.activeMicBundleIds.delete(event.bundleId)
      this.handleMicDeactivated(event.bundleId)
    }
  }

  private async handleMicActivated(bundleId: string): Promise<void> {
    // Clear any pending grace timer (mic came back)
    this.clearGraceTimer()

    const inactiveMs = this.lastMicDeactivationTime
      ? Date.now() - this.lastMicDeactivationTime
      : 0
    this.lastMicDeactivationTime = null

    // Same meeting still in progress: decide whether to re-prompt
    if (this.currentMeeting && this.currentMeeting.bundleId === bundleId) {
      if (this.userResponded) return                       // user already answered, respect it
      if (inactiveMs < REPROMPT_THRESHOLD_MS) return       // mute toggle / brief blip
      this.showNotification(this.currentMeeting)           // ignored before, give another shot
      return
    }

    // If a different app activated the mic, end the old meeting and track the new one
    if (this.currentMeeting) {
      this.emitEvent({ type: 'meeting-ended', meeting: this.currentMeeting })
      this.currentMeeting = null
      this.setState('idle')
    }

    // Identify the app (may be async for browser window title queries)
    const displayName = await this.identifyApp(bundleId)

    // Skip unknown apps — only notify for recognized meeting apps and browsers
    if (!displayName) return

    // Re-check after await: the mic may have deactivated while identifyApp was
    // running (SCShareableContent has 1–2s first-call latency). Without this,
    // we'd pin a phantom meeting that never receives a deactivation event.
    if (!this.activeMicBundleIds.has(bundleId)) return

    // Re-check after await — another event may have claimed the slot while we yielded
    if (this.currentMeeting) return

    // Check user preference
    const pref = getMeetingPref(bundleId)
    if (pref === 'never') return

    const meeting: MeetingInfo = { app: displayName, bundleId }
    this.currentMeeting = meeting
    this.userResponded = false
    this.setState('meeting-detected')
    this.emitEvent({ type: 'meeting-started', meeting })

    if (pref === 'always') {
      this.emitRecordingRequest(meeting)
    } else {
      this.showNotification(meeting)
    }
  }

  private handleMicDeactivated(bundleId: string): void {
    if (!this.currentMeeting || this.currentMeeting.bundleId !== bundleId) return

    this.lastMicDeactivationTime = Date.now()

    // Start grace period — mic may come back (mute/unmute, brief glitch)
    this.clearGraceTimer()
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null
      const meeting = this.currentMeeting
      if (meeting) {
        this.currentMeeting = null
        this.userResponded = false
        this.lastMicDeactivationTime = null
        this.setState('idle')
        this.emitEvent({ type: 'meeting-ended', meeting })
      }
    }, GRACE_PERIOD_MS)
  }

  private async identifyApp(bundleId: string): Promise<string | null> {
    const normalized = normalizeBundleId(bundleId)

    // Check known native meeting apps (try original + normalized for helper processes)
    const knownName = KNOWN_MEETING_APPS[bundleId] ?? KNOWN_MEETING_APPS[normalized]
    if (knownName) return knownName

    // Check if it's a browser — need window title matching
    const browserName = BROWSER_BUNDLE_IDS[bundleId] ?? BROWSER_BUNDLE_IDS[normalized]
    if (browserName) {
      try {
        // Browser windows are owned by the parent process bundle ID, not by helpers
        // (e.g. mic fires under com.google.Chrome.helper but windows belong to
        // com.google.Chrome). Always query against the normalized parent ID.
        const titles = await audioCapture.queryBrowserWindows(normalized)
        for (const title of titles) {
          for (const { pattern, service } of WINDOW_TITLE_PATTERNS) {
            if (pattern.test(title)) return service
          }
        }
      } catch (err) {
        console.warn('Failed to query browser windows:', err)
      }
      // No pattern matched — generic browser label
      return `Call in ${browserName}`
    }

    // Unknown app — skip to avoid false positives from random mic users (Voice Memos, etc.)
    return null
  }

  private showNotification(meeting: MeetingInfo): void {
    try {
      const notification = new Notification({
        title: 'Meeting Detected',
        body: `Looks like you're in ${meeting.app}. Click to record.`
      })

      notification.on('click', () => {
        this.respondToPrompt('yes')
      })

      notification.show()
      this.emitEvent({ type: 'prompt-shown', meeting })
    } catch (err) {
      console.error('Failed to show meeting notification:', err)
    }
  }

  private setState(state: MeetingDetectionState): void {
    if (this.state === state) return
    this.state = state
    for (const listener of this.stateListeners) {
      listener(state)
    }
  }

  private emitEvent(event: MeetingDetectionEvent): void {
    for (const listener of this.eventListeners) {
      listener(event)
    }
  }

  private emitRecordingRequest(meeting: MeetingInfo): void {
    for (const listener of this.recordingRequestListeners) {
      listener(meeting)
    }
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }
}

// --- Module singleton (matches LiveTranscriptionService pattern) ---

const service = new MeetingDetectorService()

export function startMeetingDetection(): void {
  service.start()
}

export function stopMeetingDetection(): void {
  service.stop()
}

export function getMeetingDetectionState(): MeetingDetectionState {
  return service.getState()
}

export function respondToMeetingPrompt(response: MeetingPromptResponse): void {
  service.respondToPrompt(response)
}

export function getCurrentMeeting(): MeetingInfo | null {
  return service.getCurrentMeeting()
}

export function onMeetingEvent(listener: EventListener): () => void {
  return service.onMeetingEvent(listener)
}

export function onMeetingStateChange(listener: StateListener): () => void {
  return service.onStateChange(listener)
}

export function onRecordingRequest(listener: RecordingRequestListener): () => void {
  return service.onRecordingRequest(listener)
}

export function setMeetingRecording(): void {
  service.setRecording()
}
