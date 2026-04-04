import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

type AppPreference = 'always' | 'never' | 'ask'
type PrefsMap = Record<string, AppPreference>

const PREFS_PATH = join(app.getPath('userData'), 'meeting-prefs.json')

function readPrefs(): PrefsMap {
  try {
    return JSON.parse(readFileSync(PREFS_PATH, 'utf-8')) as PrefsMap
  } catch {
    return {}
  }
}

export function getMeetingPref(bundleId: string): AppPreference {
  return readPrefs()[bundleId] ?? 'ask'
}

export function setMeetingPref(bundleId: string, pref: AppPreference): void {
  const prefs = readPrefs()
  prefs[bundleId] = pref
  writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2))
}
