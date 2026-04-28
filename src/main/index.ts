import { app } from 'electron'
import { createTray } from './tray'
import { registerIpcHandlers } from './ipc'
import { logTranscriptionPlatformSupportWarning } from './live-transcription'
import { startMeetingDetection } from './meeting-detector'

// Surface uncaught errors so async crashes don't silently kill the app
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})

// Prevent double-launch — a second instance would spawn a parallel meeting
// detection poller and double-fire notifications
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// Hide dock icon — this is a menu bar app
app.dock?.hide()

app.whenReady().then(() => {
  registerIpcHandlers()
  logTranscriptionPlatformSupportWarning()
  createTray()
  startMeetingDetection()
})

app.on('render-process-gone', (_event, _webContents, details) => {
  console.error('Renderer process gone:', details)
})

app.on('child-process-gone', (_event, details) => {
  console.error('Child process gone:', details)
})

// Don't quit on window close — the app lives in the tray
app.on('window-all-closed', () => {})
