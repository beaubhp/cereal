import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootPackagePath = join(repoRoot, 'package.json')
const rootBetterSqlitePackagePath = join(repoRoot, 'node_modules', 'better-sqlite3', 'package.json')
const electronNativeDir = join(repoRoot, '.electron-native')
const electronNativePackagePath = join(electronNativeDir, 'package.json')
const electronBetterSqliteDir = join(electronNativeDir, 'node_modules', 'better-sqlite3')
const nodeGypBin = join(repoRoot, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')

function fail(message) {
  console.error(message)
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function normalizeVersion(versionRange, packageName) {
  const version = String(versionRange ?? '').replace(/^[^\d]*/, '')
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    fail(`Could not determine ${packageName} version from "${versionRange}"`)
  }
  return version
}

if (!existsSync(rootBetterSqlitePackagePath)) {
  fail('better-sqlite3 is not installed. Run npm install before preparing Electron SQLite.')
}
if (!existsSync(nodeGypBin)) {
  fail('node-gyp is not installed. Run npm install before preparing Electron SQLite.')
}

const rootPackage = readJson(rootPackagePath)
const rootBetterSqlitePackage = readJson(rootBetterSqlitePackagePath)
const electronVersion = normalizeVersion(rootPackage.devDependencies?.electron, 'electron')
const betterSqliteVersion = rootBetterSqlitePackage.version

mkdirSync(electronNativeDir, { recursive: true })
writeFileSync(
  electronNativePackagePath,
  `${JSON.stringify(
    {
      private: true,
      name: 'cereal-electron-native',
      dependencies: {
        'better-sqlite3': betterSqliteVersion
      }
    },
    null,
    2
  )}\n`
)

execFileSync(
  'npm',
  ['install', '--prefix', electronNativeDir, '--omit=dev', '--package-lock=false', '--no-audit', '--no-fund'],
  {
    cwd: repoRoot,
    stdio: 'inherit'
  }
)

execFileSync(
  process.execPath,
  [
    nodeGypBin,
    'rebuild',
    '--runtime=electron',
    `--target=${electronVersion}`,
    '--arch',
    'arm64',
    '--dist-url=https://www.electronjs.org/headers',
    '--build-from-source',
    '--release'
  ],
  {
    cwd: electronBetterSqliteDir,
    stdio: 'inherit'
  }
)
