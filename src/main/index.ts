import { app } from 'electron'
import { createTray } from './tray'
import { registerIpcHandlers } from './ipc'
import { logTranscriptionPlatformSupportWarning } from './live-transcription'
import { startMeetingDetection } from './meeting-detector'

// Hide dock icon — this is a menu bar app
app.dock?.hide()

app.whenReady().then(() => {
  registerIpcHandlers()
  logTranscriptionPlatformSupportWarning()
  createTray()
  startMeetingDetection()
})

app.on('window-all-closed', () => {
  // Don't quit on window close — the app lives in the tray
})
