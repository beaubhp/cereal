import { ipcMain, BrowserWindow } from 'electron'
import type { AppStatus, NativePingResult, PermissionState, CaptureState } from '../shared/ipc-types'
import { loadHelloAddon, getLoadError } from './native'
import * as audioCapture from './audio-capture'

let audioChunkUnsubscribe: (() => void) | null = null

export function registerIpcHandlers(): void {
  ipcMain.handle('app:get-status', (): AppStatus => {
    return { state: 'idle' }
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
}
