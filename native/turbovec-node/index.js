'use strict'

const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

const { platform, arch } = process

let nativeBinding = null

function isMusl() {
  if (!existsSync('/usr/bin/ldd')) return true
  return readFileSync('/usr/bin/ldd', 'utf8').includes('musl')
}

function tryLoad(name) {
  const p = join(__dirname, name + '.node')
  if (!existsSync(p)) return null
  try { return require(p) } catch { return null }
}

switch (platform) {
  case 'darwin':
    nativeBinding =
      tryLoad('turbovec_node.darwin-universal') ||
      (arch === 'arm64'
        ? tryLoad('turbovec_node.darwin-arm64')
        : tryLoad('turbovec_node.darwin-x64'))
    break
  case 'linux':
    if (arch === 'x64') {
      nativeBinding = isMusl()
        ? tryLoad('turbovec_node.linux-x64-musl')
        : tryLoad('turbovec_node.linux-x64-gnu')
    } else if (arch === 'arm64') {
      nativeBinding = isMusl()
        ? tryLoad('turbovec_node.linux-arm64-musl')
        : tryLoad('turbovec_node.linux-arm64-gnu')
    }
    break
  case 'win32':
    if (arch === 'x64') nativeBinding = tryLoad('turbovec_node.win32-x64-msvc')
    else if (arch === 'arm64') nativeBinding = tryLoad('turbovec_node.win32-arm64-msvc')
    break
  default:
    break
}

module.exports = nativeBinding ?? {}
