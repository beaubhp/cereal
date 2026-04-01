import { app } from 'electron'
import { createTray } from './tray'
import { registerIpcHandlers } from './ipc'

// Hide dock icon — this is a menu bar app
app.dock?.hide()

app.whenReady().then(() => {
  registerIpcHandlers()
  createTray()
})

app.on('window-all-closed', () => {
  // Don't quit on window close — the app lives in the tray
})
