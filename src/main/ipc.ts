import { ipcMain, BrowserWindow } from 'electron'
import type {
  AppStatus,
  NativePingResult,
  PermissionState,
  CaptureState,
  TranscriptionState
} from '../shared/ipc-types'
import { loadHelloAddon, getLoadError } from './native'
import * as audioCapture from './audio-capture'
import * as liveTranscription from './live-transcription'

let audioChunkUnsubscribe: (() => void) | null = null
let transcriptSegmentUnsubscribe: (() => void) | null = null
let transcriptionErrorUnsubscribe: (() => void) | null = null

export function registerIpcHandlers(): void {
  ipcMain.handle('app:get-status', (): AppStatus => {
    const transcriptionState = liveTranscription.getTranscriptionState()
    return {
      state: transcriptionState === 'starting' || transcriptionState === 'recording' ? 'recording' : 'idle'
    }
  })

  ipcMain.handle('native:ping', (): NativePingResult => {
    const addon = loadHelloAddon()
    if (!addon) {
      return {
        macosVersion: 'unknown',
        screenCaptureKitAvailable: false,
        error: getLoadError() ?? 'Native addon not loaded'
      }
    }
    return addon.getSystemInfo()
  })

  // Audio capture handlers
  ipcMain.handle('audio:check-permissions', (): PermissionState => {
    return audioCapture.checkPermissions()
  })

  ipcMain.handle('audio:request-permissions', async (): Promise<PermissionState> => {
    return audioCapture.requestPermissions()
  })

  ipcMain.handle('audio:start-capture', async (_event, sampleRate?: number): Promise<void> => {
    // TODO: Forward audioCapture.onError events over IPC so the renderer can
    // display a warning when system audio fails (e.g. Screen Recording revoked).
    // Currently errors are logged to console but the UI has no signal.
    // Subscribe to audio chunks and forward to all renderer windows
    if (!audioChunkUnsubscribe) {
      audioChunkUnsubscribe = audioCapture.onAudioChunk((source, samples, timestamp) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('audio:chunk', { source, samples, timestamp })
          }
        }
      })
    }
    await audioCapture.startCapture(sampleRate)
  })

  ipcMain.handle('audio:stop-capture', async (): Promise<void> => {
    await audioCapture.stopCapture()
    if (audioChunkUnsubscribe) {
      audioChunkUnsubscribe()
      audioChunkUnsubscribe = null
    }
  })

  ipcMain.handle('audio:get-state', (): CaptureState => {
    return audioCapture.getCaptureState()
  })

  ipcMain.handle('transcription:start-live', async (): Promise<void> => {
    ensureTranscriptionEventSubscriptions()
    await liveTranscription.startLiveTranscription()
  })

  ipcMain.handle('transcription:stop-live', async (): Promise<void> => {
    await liveTranscription.stopLiveTranscription()
  })

  ipcMain.handle('transcription:get-state', (): TranscriptionState => {
    return liveTranscription.getTranscriptionState()
  })
}

function ensureTranscriptionEventSubscriptions(): void {
  if (!transcriptSegmentUnsubscribe) {
    transcriptSegmentUnsubscribe = liveTranscription.onTranscriptSegment((segment) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('transcription:segment', segment)
        }
      }
    })
  }

  if (!transcriptionErrorUnsubscribe) {
    transcriptionErrorUnsubscribe = liveTranscription.onTranscriptionError((error) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('transcription:error', error)
        }
      }
    })
  }
}
