import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, open, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Hex } from 'viem'

// flock(1) is Linux-only (absent on macOS). On other platforms use an
// O_EXCL lock file holding the owner PID; a lock whose PID is no longer alive is treated as stale.
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
async function acquirePortableLock(lockPath: string): Promise<() => Promise<void>> {
  for (let attempt = 0; ; attempt++) {
    try {
      const h = await open(lockPath, 'wx', 0o600)
      try { await h.writeFile(String(process.pid)); await h.sync() } finally { await h.close() }
      return async () => { await rm(lockPath, { force: true }) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let pid = NaN
      try { pid = Number((await readFile(lockPath, 'utf8')).trim()) } catch { /* vanished */ }
      if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) { await rm(lockPath, { force: true }); continue }
      if (attempt > 1200) throw new Error('Cannot lock payment journal')
      await new Promise(r => setTimeout(r, 50))
    }
  }
}

export interface Journal<S> {
  last: S | undefined
  append(state: S): Promise<void>
}

async function syncDirectory(path: string) {
  const dir = await open(path, 'r')
  try { await dir.sync() } finally { await dir.close() }
}

/** One append-only file and one kernel-owned lock per request. The file is never replaced. */
export class Store<S extends { requestId: Hex }> {
  private constructor(readonly directory: string) {}
  static async open<S extends { requestId: Hex }>(path: string): Promise<Store<S>> {
    const directory = resolve(path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await syncDirectory(dirname(directory))
    const store = new Store<S>(directory)
    // Replay under the same lock a writer uses, including on independent restarts.
    for (const name of await readdir(directory)) {
      if (name.endsWith('.jsonl')) await store.withRequest(name.slice(0, -6), async () => {})
    }
    return store
  }

  async withRequest<T>(id: string, fn: (journal: Journal<S>) => Promise<T>): Promise<T> {
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error('Invalid requestId')
    const file = await open(join(this.directory, id + '.jsonl'), 'a+', 0o600)
    let release: (() => Promise<void>) | undefined
    try {
      if (process.platform === 'linux') {
        // flock(1) locks our inherited open file description. Closing it releases
        // the lock even after process death. Waiting in a child keeps JS responsive.
        const lock = spawn('flock', ['-x', '3'], { stdio: ['ignore', 'ignore', 'ignore', file.fd] })
        const [code] = await once(lock, 'exit')
        if (code !== 0) throw new Error('Cannot lock payment journal')
      } else {
        release = await acquirePortableLock(join(this.directory, id + '.lock'))
      }
      await syncDirectory(this.directory)
      const contents = await file.readFile('utf8')
      if (contents && !contents.endsWith('\n')) throw new Error('Incomplete journal tail: ' + id)
      let last: S | undefined
      for (const line of contents.split('\n').slice(0, -1)) {
        last = JSON.parse(line) as S
        if (!last || last.requestId !== id) throw new Error('Journal identity mismatch')
      }
      const journal: Journal<S> = {
        last,
        async append(state) {
          if (state.requestId !== id) throw new Error('Journal identity mismatch')
          await file.appendFile(JSON.stringify(state) + '\n')
          await file.sync()
          journal.last = state
        },
      }
      return await fn(journal)
    } finally {
      await file.close()
      if (release) await release()
    }
  }
}
