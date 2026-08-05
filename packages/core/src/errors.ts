export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError'
}
