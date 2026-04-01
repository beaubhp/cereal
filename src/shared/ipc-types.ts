export type AppState = 'idle' | 'recording' | 'processing'

export interface AppStatus {
  state: AppState
}

export interface NativePingResult {
  macosVersion: string
  screenCaptureKitAvailable: boolean
  error?: string
}

export interface IpcApi {
  getStatus: () => Promise<AppStatus>
  nativePing: () => Promise<NativePingResult>
}
