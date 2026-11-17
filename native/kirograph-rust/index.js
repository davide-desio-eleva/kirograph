'use strict'

/**
 * Loads the native binary for this platform: a build in this folder (development, or a build
 * from source), otherwise the platform package npm installed (kirograph-rust-<platform>).
 * Exports an empty object when there is none, so the caller can fall back.
 */

const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

function isMusl() {
  if (process.platform !== 'linux') return false
  try { return readFileSync('/usr/bin/ldd', 'utf8').includes('musl') } catch { return false }
}

/** The platform suffix used for binary and package names, or null when no build exists for it. */
function platformSuffix() {
  const { platform, arch } = process
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `darwin-${arch}`
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) return `linux-${arch}-${isMusl() ? 'musl' : 'gnu'}`
  if (platform === 'win32' && arch === 'x64') return 'win32-x64-msvc'
  return null
}

function load() {
  const suffix = platformSuffix()
  if (!suffix) return {}
  const local = join(__dirname, `kirograph_rust.${suffix}.node`)
  if (existsSync(local)) return require(local)
  try {
    return require(`kirograph-rust-${suffix}`)
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`kirograph-rust-${suffix}`)) return {}
    throw err // installed but does not load: say why
  }
}

module.exports = load()
