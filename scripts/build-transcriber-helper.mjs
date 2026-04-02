import { copyFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = join(repoRoot, 'src', 'native', 'transcriber-helper')
const outputDir = join(repoRoot, 'src', 'native', 'build', 'Release')
const builtBinary = join(packagePath, '.build', 'release', 'transcriber_helper')
const destinationBinary = join(outputDir, 'transcriber_helper')

function fail(message) {
  console.error(message)
  process.exit(1)
}

function verifyXcode() {
  let output = ''
  try {
    output = execFileSync('xcodebuild', ['-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr)
      : ''
    fail(
      `Full Xcode is required to build the WhisperKit helper.\n${stderr || 'Install Xcode and run sudo xcode-select -s /Applications/Xcode.app/Contents/Developer'}`
    )
  }

  const versionLine = output.split('\n').find((line) => line.startsWith('Xcode '))
  const majorVersion = Number.parseInt(versionLine?.split(' ')[1]?.split('.')[0] ?? '', 10)
  if (!Number.isFinite(majorVersion) || majorVersion < 16) {
    fail(`Xcode 16 or later is required to build the WhisperKit helper. Found: ${versionLine ?? 'unknown version'}`)
  }
}

verifyXcode()

execFileSync('swift', ['build', '-c', 'release', '--package-path', packagePath], {
  cwd: repoRoot,
  stdio: 'inherit'
})

if (!existsSync(builtBinary)) {
  fail(`Expected helper binary at ${builtBinary}, but Swift build did not produce it.`)
}

mkdirSync(outputDir, { recursive: true })
copyFileSync(builtBinary, destinationBinary)
chmodSync(destinationBinary, 0o755)
