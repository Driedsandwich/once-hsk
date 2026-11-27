import { isIPv6 } from 'node:net'
import { lookup } from 'node:dns'
import { Agent } from 'undici'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { isObject, ToolError, toolNames } from './types.js'
import type { Hsp, Input, Output, Tool } from './types.js'

export interface ClientOptions {
  url: string | URL
  ipv4Only?: boolean
  timeoutMs?: number
}

export class McpClient implements Hsp {
  private readonly sdk = new Client({ name: 'hsp-pay-once', version: '1.0.0' })
  private readonly agent?: Agent
  private constructor(private readonly options: ClientOptions) {
    if (options.ipv4Only) {
      const host = new URL(options.url).hostname.replace(/^\[|\]$/g, '')
      if (isIPv6(host)) throw new Error('IPv6 address supplied in IPv4-only mode')
      this.agent = new Agent({ connect: {
        family: 4,
        lookup: (host, opts, callback) => lookup(host, { ...opts, family: 4 }, callback),
      } })
    }
  }

  static async connect(options: ClientOptions): Promise<McpClient> {
    const c = new McpClient(options)
    try {
      const transport = new StreamableHTTPClientTransport(new URL(options.url), {
        fetch: (url, init) => {
          const settings = { ...init, dispatcher: c.agent, redirect: 'error' as const }
          // Bound individual HTTP exchanges. A session's GET event stream is long-lived.
          if (init?.method === 'POST') {
            const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
            settings.signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
          }
          return fetch(url, settings)
        },
      })
      await c.sdk.connect(transport)
      const found = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await c.sdk.listTools({ cursor })
        for (const tool of page.tools) found.add(tool.name)
        cursor = page.nextCursor
        if (cursor && cursors.has(cursor)) throw new Error('Repeated tools/list cursor')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      const missing = toolNames.filter(name => !found.has(name))
      if (missing.length) throw new Error(`Missing required HSP tools: ${missing.join(', ')}`)
      return c
    } catch (error) {
      await c.close()
      throw error
    }
  }

  async call<K extends Tool>(tool: K, input: Input<K>, timeoutMs?: number): Promise<Output<K>> {
    const timeout = Math.min(timeoutMs ?? Infinity, this.options.timeoutMs ?? 15_000)
    const result = await this.sdk.callTool({ name: tool, arguments: { ...input } }, undefined, {
      timeout, signal: AbortSignal.timeout(timeout),
    }).catch((error: unknown) => {
      if (error instanceof McpError) throw new ToolError(tool, { code: error.code, data: error.data })
      throw error
    })
    let value: unknown = result.structuredContent
    if (value === undefined && Array.isArray(result.content)) {
      const item = result.content.length === 1 ? result.content[0] : undefined
      if (isObject(item) && item.type === 'text' && typeof item.text === 'string') {
        try { value = JSON.parse(item.text) } catch { value = item.text }
      }
    }
    if (result.isError || (isObject(value) && (isObject(value.error) || String(value.code) === '30043'))) {
      throw new ToolError(tool, value)
    }
    if (value === undefined) throw new Error(`Missing tool result (${tool})`)
    return value as Output<K>
  }

  async close() {
    try { await this.sdk.close() } finally { await this.agent?.destroy() }
  }
}
