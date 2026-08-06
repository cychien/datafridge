import { ConfigError } from './errors.js'
import type { QueryParams } from './types.js'

export const VARIANT_KEY_PREFIX = '@df/v1/'

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export function queryKey(name: string, params?: QueryParams): string {
  validateQueryName(name)
  if (params === undefined) return name
  return `${VARIANT_KEY_PREFIX}${encodeURIComponent(name)}/${sha256(canonicalJson(params))}`
}

export function snapshotQueryParams(params: QueryParams): QueryParams {
  return deepFreeze(JSON.parse(canonicalJson(params)) as QueryParams)
}

export function validateQueryName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ConfigError('query name must be a non-empty string')
  }
  if (name.startsWith(VARIANT_KEY_PREFIX)) {
    throw new ConfigError(`query name must not start with reserved prefix '${VARIANT_KEY_PREFIX}'`)
  }
}

function canonicalJson(value: QueryParams): string {
  return canonicalize(value, new Set<object>())
}

function canonicalize(value: QueryParams, ancestors: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConfigError('query params must contain finite numbers')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') {
    throw new ConfigError(
      'query params must be JSON values without undefined, functions, or symbols',
    )
  }
  if (ancestors.has(value)) throw new ConfigError('query params must not contain cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new ConfigError('query params must not contain sparse arrays')
        }
        items.push(canonicalize(value[index] as QueryParams, ancestors))
      }
      return `[${items.join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ConfigError('query params must contain only arrays and plain objects')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new ConfigError('query params must not contain symbol keys')
    }
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new ConfigError('query params must contain only enumerable data properties')
      }
    }
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(
            (value as Readonly<Record<string, QueryParams>>)[key] as QueryParams,
            ancestors,
          )}`,
      )
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function sha256(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  const bitLength = bytes.length * 8
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const words = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const x = words[i - 15]!
      const y = words[i - 2]!
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let i = 0; i < 64; i += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choice + SHA256_CONSTANTS[i]! + words[i]!) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, '0')).join('')
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

function deepFreeze(value: QueryParams): QueryParams {
  if (value !== null && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
