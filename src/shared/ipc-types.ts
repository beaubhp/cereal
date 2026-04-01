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
}
