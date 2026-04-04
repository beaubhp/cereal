export type AppState = 'idle' | 'recording' | 'processing'

export interface AppStatus {
  state: AppState
}

export interface NativePingResult {
  macosVersion: string
  screenCaptureKitAvailable: boolean
  error?: string
}

export type PermissionStatus = 'granted' | 'denied' | 'undetermined'

export interface PermissionState {
  microphone: PermissionStatus
  screenRecording: PermissionStatus
}

export type CaptureState = 'idle' | 'starting' | 'recording' | 'stopping'

export interface AudioChunk {
  source: 'mic' | 'system'
  samples: Float32Array
  timestamp: number
}

export type TranscriptionState = 'idle' | 'starting' | 'recording' | 'stopping' | 'error'

export interface TranscriptSegment {
  id: string
  source: 'mic' | 'system'
  isMe: boolean
  text: string
  startTimeSec: number
  endTimeSec: number
  sequence: number
}

export interface TranscriptionError {
  code: string
  message: string
  fatal: boolean
}

// Meeting detection
export type MeetingDetectionState = 'idle' | 'meeting-detected' | 'recording'

export interface MeetingInfo {
  app: string // Display name: "Zoom", "Google Meet", "Call in Chrome", etc.
  bundleId: string // Source bundle ID
}

export interface MeetingDetectionEvent {
  type: 'meeting-started' | 'meeting-ended' | 'prompt-shown'
  meeting: MeetingInfo
}

export type MeetingPromptResponse = 'yes' | 'no' | 'always' | 'never'

export interface IpcApi {
  getStatus: () => Promise<AppStatus>
  nativePing: () => Promise<NativePingResult>
  // Audio capture
  checkPermissions: () => Promise<PermissionState>
  requestPermissions: () => Promise<PermissionState>
  startCapture: (sampleRate?: number) => Promise<void>
  stopCapture: () => Promise<void>
  getCaptureState: () => Promise<CaptureState>
  onAudioChunk: (callback: (chunk: AudioChunk) => void) => () => void
  // Real-time transcription
  startLiveTranscription: () => Promise<void>
  stopLiveTranscription: () => Promise<void>
  getTranscriptionState: () => Promise<TranscriptionState>
  onTranscriptSegment: (callback: (segment: TranscriptSegment) => void) => () => void
  onTranscriptionError: (callback: (error: TranscriptionError) => void) => () => void
  // Meeting detection
  getMeetingDetectionState: () => Promise<MeetingDetectionState>
  respondToMeetingPrompt: (response: MeetingPromptResponse) => Promise<void>
  getCurrentMeeting: () => Promise<MeetingInfo | null>
  onMeetingEvent: (callback: (event: MeetingDetectionEvent) => void) => () => void
  onMeetingStateChange: (callback: (state: MeetingDetectionState) => void) => () => void
}
