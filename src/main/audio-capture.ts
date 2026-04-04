import type { PermissionState, CaptureState } from '../shared/ipc-types'
import { getAddonPath } from './native'

interface MicEvent {
  bundleId: string
  appName: string
  micActive: boolean
}

interface AudioCaptureAddon {
  checkPermissions: () => { microphone: string; screenRecording: string }
  requestPermissions: (callback: () => void) => void
  startCapture: (
    config: { sampleRate?: number },
    micCallback: (samples: Float32Array, timestamp: number) => void,
    systemCallback: (samples: Float32Array, timestamp: number) => void,
    errorCallback: (message: string) => void
  ) => Promise<void>
  stopCapture: () => Promise<void>
  getCaptureState: () => string
  startMeetingMonitor: (callback: (event: MicEvent) => void) => void
  stopMeetingMonitor: () => void
  queryBrowserWindows: (bundleId: string, callback: (titles: string[]) => void) => void
}

let addon: AudioCaptureAddon | null = null
let loadError: string | null = null

type ChunkListener = (source: 'mic' | 'system', samples: Float32Array, timestamp: number) => void
type ErrorListener = (message: string) => void
const chunkListeners: Set<ChunkListener> = new Set()
const errorListeners: Set<ErrorListener> = new Set()

function loadAddon(): AudioCaptureAddon | null {
  if (addon) return addon
  if (loadError) return null

  try {
    const addonPath = getAddonPath('audio_capture')
    addon = require(addonPath) as AudioCaptureAddon
    return addon
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    console.error('Failed to load audio_capture addon:', loadError)
    return null
  }
}

export function checkPermissions(): PermissionState {
  const a = loadAddon()
  if (!a) {
    return { microphone: 'denied', screenRecording: 'denied' }
  }
  const result = a.checkPermissions()
  return {
    microphone: result.microphone as PermissionState['microphone'],
    screenRecording: result.screenRecording as PermissionState['screenRecording']
  }
}

export async function requestPermissions(): Promise<PermissionState> {
  const a = loadAddon()
  if (!a) {
    return { microphone: 'denied', screenRecording: 'denied' }
  }
  // Wait for the mic permission dialog to be dismissed
  await new Promise<void>((resolve) => {
    a.requestPermissions(() => resolve())
  })
  // Re-check after request
  return checkPermissions()
}

export async function startCapture(sampleRate = 16000): Promise<void> {
  const a = loadAddon()
  if (!a) {
    throw new Error(loadError ?? 'Audio capture addon not loaded')
  }

  await a.startCapture(
    { sampleRate },
    (samples: Float32Array, timestamp: number) => {
      for (const listener of chunkListeners) {
        listener('mic', samples, timestamp)
      }
    },
    (samples: Float32Array, timestamp: number) => {
      for (const listener of chunkListeners) {
        listener('system', samples, timestamp)
      }
    },
    (message: string) => {
      console.error('Audio capture error:', message)
      for (const listener of errorListeners) {
        listener(message)
      }
    }
  )
}

export async function stopCapture(): Promise<void> {
  const a = loadAddon()
  if (!a) return
  await a.stopCapture()
}

export function getCaptureState(): CaptureState {
  const a = loadAddon()
  if (!a) return 'idle'
  return a.getCaptureState() as CaptureState
}

export function onAudioChunk(listener: ChunkListener): () => void {
  chunkListeners.add(listener)
  return () => chunkListeners.delete(listener)
}

export function onError(listener: ErrorListener): () => void {
  errorListeners.add(listener)
  return () => errorListeners.delete(listener)
}

export function getAudioCaptureLoadError(): string | null {
  return loadError
}

// --- Meeting monitor ---

export type MicEventListener = (event: MicEvent) => void
const micEventListeners: Set<MicEventListener> = new Set()

export function startMeetingMonitor(): void {
  const a = loadAddon()
  if (!a) throw new Error(loadError ?? 'Audio capture addon not loaded')
  a.startMeetingMonitor((event) => {
    for (const listener of micEventListeners) {
      listener(event)
    }
  })
}

export function stopMeetingMonitor(): void {
  const a = loadAddon()
  if (!a) return
  a.stopMeetingMonitor()
}

export function onMicEvent(listener: MicEventListener): () => void {
  micEventListeners.add(listener)
  return () => micEventListeners.delete(listener)
}

export function queryBrowserWindows(bundleId: string): Promise<string[]> {
  return new Promise((resolve) => {
    const a = loadAddon()
    if (!a) {
      resolve([])
      return
    }
    a.queryBrowserWindows(bundleId, (titles) => resolve(titles))
  })
}
