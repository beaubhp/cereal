import { ipcMain } from 'electron'
import type { AppStatus, NativePingResult } from '../shared/ipc-types'
import { loadHelloAddon, getLoadError } from './native'

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
}
