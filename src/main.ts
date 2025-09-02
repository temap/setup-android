import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import * as exec from '@actions/exec'
import * as cache from '@actions/cache'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as crypto from 'crypto'

function getVersionShort(versionLong: string): string {
  switch (versionLong) {
    case '12266719':
      return '16.0'
    case '11479570':
      return '13.0'
    case '11076708':
      return '12.0'
    case '10406996':
      return '11.0'
    case '9862592':
      return '10.0'
    case '9477386':
      return '9.0'
    case '9123335':
      return '8.0'
    case '8512546':
      return '7.0'
    default:
      return versionLong
  }
}

const VERSION_LONG = core.getInput('cmdline-tools-version', {
  trimWhitespace: true
})
if (VERSION_LONG.includes('/') || VERSION_LONG.includes('\\')) {
  core.setFailed('Malformed cmdline-tools-version!')
  throw new Error('Malformed cmdline-tools-version!')
}
const VERSION_SHORT = getVersionShort(VERSION_LONG)

const COMMANDLINE_TOOLS_WIN_URL = `https://dl.google.com/android/repository/commandlinetools-win-${VERSION_LONG}_latest.zip`
const COMMANDLINE_TOOLS_MAC_URL = `https://dl.google.com/android/repository/commandlinetools-mac-${VERSION_LONG}_latest.zip`
const COMMANDLINE_TOOLS_LIN_URL = `https://dl.google.com/android/repository/commandlinetools-linux-${VERSION_LONG}_latest.zip`

const ANDROID_HOME_SDK_DIR = path.join(os.homedir(), '.android', 'sdk')
let ANDROID_SDK_ROOT = process.env['ANDROID_SDK_ROOT'] || ANDROID_HOME_SDK_DIR

async function callSdkManager(
  sdkManager: string,
  arg: string,
  printOutput: Boolean = true
): Promise<void> {
  const acceptBuffer = Buffer.from(Array(10).fill('y').join('\n'), 'utf8')
  await exec.exec(sdkManager, [arg], {
    input: acceptBuffer,
    silent: !printOutput
  })
}

async function installSdkManager(): Promise<string> {
  const cmdlineTools = path.join(
    ANDROID_SDK_ROOT,
    'cmdline-tools',
    VERSION_SHORT
  )
  let sdkManagerExe = path.join(cmdlineTools, 'bin', 'sdkmanager')

  if (!fs.existsSync(sdkManagerExe)) {
    const latestCmdlineTools = path.join(
      ANDROID_SDK_ROOT,
      'cmdline-tools',
      'latest'
    )
    const sourcePropertiesFile = path.join(
      latestCmdlineTools,
      'source.properties'
    )
    const latestSdkManagerExe = path.join(
      latestCmdlineTools,
      'bin',
      'sdkmanager'
    )
    if (
      fs.existsSync(latestCmdlineTools) &&
      fs.existsSync(sourcePropertiesFile) &&
      fs.existsSync(latestSdkManagerExe)
    ) {
      const sourceProperties = fs.readFileSync(sourcePropertiesFile)
      core.info(
        `Found preinstalled sdkmanager in ${latestCmdlineTools} with following source.properties:`
      )
      core.info(sourceProperties.toString())
      if (sourceProperties.includes(`Pkg.Revision=${VERSION_SHORT}`)) {
        core.info(`Preinstalled sdkmanager has the correct version`)
        sdkManagerExe = latestSdkManagerExe
      } else {
        core.info(`Wrong version in preinstalled sdkmanager`)
      }
    }
  }

  if (!fs.existsSync(sdkManagerExe)) {
    let cmdlineToolsURL
    if (process.platform === 'linux') {
      cmdlineToolsURL = COMMANDLINE_TOOLS_LIN_URL
    } else if (process.platform === 'darwin') {
      cmdlineToolsURL = COMMANDLINE_TOOLS_MAC_URL
    } else if (process.platform === 'win32') {
      cmdlineToolsURL = COMMANDLINE_TOOLS_WIN_URL
    } else {
      core.error(`Unsupported platform: ${process.platform}`)
      return ''
    }

    core.info(`Downloading commandline tools from ${cmdlineToolsURL}`)
    const cmdlineToolsZip = await tc.downloadTool(cmdlineToolsURL)

    const extractTo = path.join(ANDROID_SDK_ROOT, 'cmdline-tools')
    await tc.extractZip(cmdlineToolsZip, extractTo)

    // Make sure we don't have leftover target directory (happens sometimes...)
    if (fs.existsSync(cmdlineTools)) {
      core.info(`Removing leftovers from ${cmdlineTools}`)
      fs.rmSync(cmdlineTools, {recursive: true})
    }
    fs.renameSync(path.join(extractTo, 'cmdline-tools'), cmdlineTools)
  }

  // touch $ANDROID_SDK_ROOT/repositories.cfg
  fs.closeSync(
    fs.openSync(path.join(ANDROID_SDK_ROOT, 'repositories.cfg'), 'w')
  )
  core.debug(`sdkmanager available at: ${sdkManagerExe}`)
  return sdkManagerExe
}

async function restoreCache(
  cmdlineToolsVersion: string,
  packages: string[]
): Promise<string | undefined> {
  const cacheEnabled = core.getBooleanInput('cache')
  if (!cacheEnabled) {
    core.info('Cache is disabled')
    return undefined
  }

  try {
    const platform = process.platform
    const arch = process.arch

    // Create a hash of packages for cache key
    const packagesHash = crypto
      .createHash('sha256')
      .update(packages.sort().join(','))
      .digest('hex')
      .substring(0, 8)

    // Cache key includes platform, architecture, cmdline-tools version, and packages
    const cacheKey = `setup-android-${platform}-${arch}-cmdlinetools-${cmdlineToolsVersion}-packages-${packagesHash}`
    const cachePaths = [
      path.join(ANDROID_SDK_ROOT, 'cmdline-tools'),
      path.join(ANDROID_SDK_ROOT, 'platform-tools'),
      path.join(ANDROID_SDK_ROOT, 'tools'),
      path.join(ANDROID_SDK_ROOT, 'licenses'),
      path.join(ANDROID_SDK_ROOT, 'platforms'),
      path.join(ANDROID_SDK_ROOT, 'build-tools'),
      path.join(ANDROID_SDK_ROOT, 'system-images'),
      path.join(ANDROID_SDK_ROOT, 'extras')
    ].filter(p => fs.existsSync(p))

    core.info(`Attempting to restore cache with key: ${cacheKey}`)
    const cacheHit = await cache.restoreCache(cachePaths, cacheKey)

    if (cacheHit) {
      core.info(`Cache restored from key: ${cacheHit}`)
      return cacheKey
    } else {
      core.info('Cache not found')
      return cacheKey
    }
  } catch (error) {
    core.warning(`Failed to restore cache: ${error}`)
    return undefined
  }
}

async function saveCache(cacheKey: string | undefined): Promise<void> {
  if (!cacheKey) {
    return
  }

  const cacheEnabled = core.getBooleanInput('cache')
  if (!cacheEnabled) {
    return
  }

  try {
    const cachePaths = [
      path.join(ANDROID_SDK_ROOT, 'cmdline-tools'),
      path.join(ANDROID_SDK_ROOT, 'platform-tools'),
      path.join(ANDROID_SDK_ROOT, 'tools'),
      path.join(ANDROID_SDK_ROOT, 'licenses'),
      path.join(ANDROID_SDK_ROOT, 'platforms'),
      path.join(ANDROID_SDK_ROOT, 'build-tools'),
      path.join(ANDROID_SDK_ROOT, 'system-images'),
      path.join(ANDROID_SDK_ROOT, 'extras')
    ].filter(p => fs.existsSync(p))

    core.info(`Saving cache with key: ${cacheKey}`)
    await cache.saveCache(cachePaths, cacheKey)
    core.info('Cache saved successfully')
  } catch (error) {
    core.warning(`Failed to save cache: ${error}`)
  }
}

async function run(): Promise<void> {
  if ('win16' === process.env['ImageOS']) {
    if (-1 !== ANDROID_SDK_ROOT.indexOf(' ')) {
      // On Windows2016, Android SDK is installed to Program Files,
      // and it doesn't really work..
      // C:\windows\system32\cmd.exe /D /S /C ""C:\Program Files (x86)\Android\android-sdk\cmdline-tools\3.0\bin\sdkmanager.bat" --licenses"
      // Error: Could not find or load main class Files

      const newSDKLocation = ANDROID_SDK_ROOT.replace(/\s/gi, '-')
      core.debug(`moving ${ANDROID_SDK_ROOT} to ${newSDKLocation}`)
      fs.mkdirSync(path.dirname(newSDKLocation), {recursive: true})

      // intentionally using fs.renameSync,
      // because it doesn't move across drives
      fs.renameSync(ANDROID_SDK_ROOT, newSDKLocation)
      ANDROID_SDK_ROOT = newSDKLocation
    }
  }

  const sdkManagerExe = await installSdkManager()

  if (core.getBooleanInput('accept-android-sdk-licenses')) {
    core.info('Accepting Android SDK licenses')
    await callSdkManager(
      sdkManagerExe,
      '--licenses',
      core.getBooleanInput('log-accepted-android-sdk-licenses')
    )
  }

  const packages = core
    .getInput('packages', {required: false})
    .split(' ')
    .map(function (str) {
      return str.trim()
    })
    /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
    .filter(function (element, index, array) {
      return element
    })

  // Try to restore cache before installing
  const cacheKey = await restoreCache(VERSION_LONG, packages)
  for (const pkg of packages) {
    await callSdkManager(sdkManagerExe, pkg)
  }

  core.setOutput('ANDROID_COMMANDLINE_TOOLS_VERSION', VERSION_LONG)
  core.exportVariable('ANDROID_HOME', ANDROID_SDK_ROOT)
  core.exportVariable('ANDROID_SDK_ROOT', ANDROID_SDK_ROOT)

  core.addPath(path.dirname(sdkManagerExe))
  core.addPath(path.join(ANDROID_SDK_ROOT, 'platform-tools'))

  core.debug('add matchers')
  // eslint-disable-next-line no-console
  console.log(`##[add-matcher]${path.join(__dirname, '..', 'matchers.json')}`)

  // Save cache after installation
  await saveCache(cacheKey)
}

run()
