import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { McpClient } from '../src/hsp/mcpClient.js'
import { mockAbsent, selectMockAsset, startMock } from '../src/hsp/mockServer.js'
import { PayOnce, type Approval, type Entry, type Result } from '../src/payOnce.js'
import { Store } from '../src/store.js'
import { mockIntent } from './mockIntent.js'

async function worker(mode: string, url: string, dir: string, id?: Hex) {
  const hsp = await McpClient.connect({ url, ipv4Only: true })
  try {
    // Only the original process holds a key. Recovery has no signing capability.
    const account = mode === 'pay' ? privateKeyToAccount(generatePrivateKey()) : undefined
    const approve = async (stage: string, a: Approval) => {
      if (!account) throw new Error('Unexpected approval during recovery')
      console.log(`[模擬承認・${stage}] payer=${a.payer} pay_to=${a.pay_to} token_total_raw=${a.token_total_raw}`)
      return true
    }
    const pay = new PayOnce({
      hsp, store: await Store.open<Entry>(dir), selectAsset: selectMockAsset, isDefinitivelyAbsent: mockAbsent,
      approveSign: a => approve('署名前', a), approveSubmit: a => approve('送信前', a),
      async signTypedData(message) {
        if (!account) throw new Error('Unexpected signature during recovery')
        return account.signTypedData(message)
      },
    })
    if (account) {
      await pay.pay(mockIntent(account.address, Date.now()))
      throw new Error('Original process unexpectedly survived submit')
    }
    if (!id) throw new Error('Missing requestId for recovery')
    process.send?.(await pay.resume(id))
  } finally { await hsp.close() }
}

async function demo() {
  const dir = await mkdtemp(join(tmpdir(), 'hsp-crash-demo-'))
  let first: ChildProcess | undefined
  const mock = await startMock({
    onAccepted() { first?.kill('SIGKILL') },
    submitDelayMs: 100,
  })
  const child = (args: string[]) => fork(fileURLToPath(import.meta.url), args, {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  try {
    first = child(['pay', mock.url, dir])
    const [, signal] = await once(first, 'exit')
    if (signal !== 'SIGKILL') throw new Error('Crash injection failed')
    const [name] = await readdir(dir)
    if (!name) throw new Error('Missing journal')
    const entries = (await readFile(join(dir, name), 'utf8')).trimEnd().split('\n')
    const last = JSON.parse(entries.at(-1)!) as Entry
    if (last.step.state !== 'SUBMIT_INTENT') throw new Error('Unexpected crash boundary')
    const callsBefore = mock.audit.calls.length
    const submitsBefore = mock.audit.submitCalls
    const second = child(['resume', mock.url, dir, last.requestId])
    let result: Result | undefined
    second.on('message', value => { result = value as Result })
    const [code] = await once(second, 'exit')
    const recoveredCalls = mock.audit.calls.slice(callsBefore)
    if (code !== 0 || result?.state !== 'CONFIRMED' || recoveredCalls.join() !== 'query_payment' ||
        mock.audit.submitCalls !== 1 || mock.audit.accepted !== 1) throw new Error('Demo invariant failed')
    console.log('requestId', last.requestId)
    console.table([
      { 場面: '受付直後に強制終了', 記録: last.step.state, submit累計: submitsBefore, 注文数: mock.audit.orderCount },
      { 場面: '別プロセスで照会', 記録: result.state, submit累計: mock.audit.submitCalls, 注文数: mock.audit.orderCount },
    ])
    console.log('復旧時の呼び出し', recoveredCalls.join(', '), '／ HSP の状態', result.status)
  } finally {
    await mock.close()
    await rm(dir, { recursive: true, force: true })
  }
}

const [mode, url, dir, id] = process.argv.slice(2)
if (mode && url && dir) await worker(mode, url, dir, id as Hex | undefined)
else await demo()
