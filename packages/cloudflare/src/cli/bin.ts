import process from 'node:process'
import { runCli } from './run.js'

process.exitCode = runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  today: () => new Date().toISOString().slice(0, 10),
})
