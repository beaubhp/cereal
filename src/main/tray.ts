import { app, BrowserWindow, Tray, nativeImage, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import * as meetingDetector from './meeting-detector'
import type { MeetingDetectionState } from '../shared/ipc-types'

let tray: Tray | null = null
let popoverWindow: BrowserWindow | null = null
let isQuitting = false

function getTrayIconName(state: MeetingDetectionState): string {
  switch (state) {
    case 'meeting-detected':
      return 'tray-bowl-detected'
    case 'recording':
      return 'tray-bowl-recording'
    default:
      return 'tray-bowl'
  }
}

function getTrayIconPath(iconName = 'tray-bowl'): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'icons', `${iconName}.png`)
  }

  return join(__dirname, `../../resources/icons/${iconName}.png`)
}

function loadTrayIcon(iconName = 'tray-bowl'): Electron.NativeImage {
  const icon = nativeImage.createFromPath(getTrayIconPath(iconName))

  if (icon.isEmpty()) {
    // Fall back to default icon if state-specific icon is missing
    if (iconName !== 'tray-bowl') {
      return loadTrayIcon('tray-bowl')
    }
    console.error(`Failed to load tray icon from ${getTrayIconPath(iconName)}`)
    return nativeImage.createEmpty()
  }

  icon.setTemplateImage(true)
  return icon
}

function createPopoverWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 400,
    height: 600,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Hide instead of close
  win.on('close', (e) => {
    if (isQuitting) {
      return
    }

    e.preventDefault()
    win.hide()
  })

  // Hide when focus is lost
  win.on('blur', () => {
    if (!isQuitting) {
      win.hide()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function positionWindowBelowTray(win: BrowserWindow, trayBounds: Electron.Rectangle): void {
  const winBounds = win.getBounds()
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y
  })

  const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2)
  const y = trayBounds.y + trayBounds.height + 4

  // Clamp to screen bounds
  const clampedX = Math.max(
    display.workArea.x,
    Math.min(x, display.workArea.x + display.workArea.width - winBounds.width)
  )

  win.setPosition(clampedX, y)
}

export function createTray(): void {
  app.on('before-quit', () => {
    isQuitting = true
  })

  tray = new Tray(loadTrayIcon())
  tray.setToolTip('Cereal')

  popoverWindow = createPopoverWindow()

  tray.on('click', () => {
    if (!popoverWindow) return

    if (popoverWindow.isVisible()) {
      popoverWindow.hide()
    } else {
      const bounds = tray!.getBounds()
      positionWindowBelowTray(popoverWindow, bounds)
      popoverWindow.show()
    }
  })

  // Update tray icon based on meeting detection state
  meetingDetector.onMeetingStateChange((state) => {
    if (!tray) return
    const iconName = getTrayIconName(state)
    const icon = loadTrayIcon(iconName)
    tray.setImage(icon)
  })
}

export function getPopoverWindow(): BrowserWindow | null {
  return popoverWindow
}
