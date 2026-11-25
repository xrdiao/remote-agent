import http from 'node:http';
import crypto from 'node:crypto';

// MCP is a native tool transport. The existing Runner owns all decisions/state.
export class FusionMcpServer {
  constructor() { this.listeners = new Map(); }
  listen(port) {
    const entry = { channels: new Map(), leases: 0 };
    const server = entry.server = http.createServer((request, response) => {
      this.receive(entry, request, response).catch(() => response.destroy());
    });
    this.listeners.set(port, entry);
    entry.ready = new Promise((resolve, reject) => {
      const failed = error => { this.listeners.delete(port); reject(error); };
      server.once('error', failed);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', failed);
        server.on('error', error => console.error('[Fusion MCP]', error.message));
        server.unref();
        entry.port = server.address().port;
        this.listeners.delete(port);
        this.listeners.set(entry.port, entry);
        resolve();
      });
    });
    return entry;
  }
  async bind(binding, { tools, instructions, identify, changed, recordConfig }) {
    const port = binding.mcp?.port;
    const entry = (port ? this.listeners.get(port) : this.listeners.values().next().value) || this.listen(port || 0);
    entry.leases++;
    const release = async () => {
      if (--entry.leases) return;
      if (this.listeners.get(entry.port) === entry) this.listeners.delete(entry.port);
      if (entry.server.listening) await new Promise(resolve => entry.server.close(resolve));
    };
    try {
      await entry.ready;
      const mcp = binding.mcp || { token: crypto.randomBytes(24).toString('hex'), port: entry.port };
      if (entry.channels.has(mcp.token)) throw new Error('这个 Fusion 原生工具通道已被占用');
      if (!binding.mcp) recordConfig(mcp);
      const channel = { tools, instructions, identify, changed, pending: new Map(), claimed: new Set(), closed: false };
      entry.channels.set(mcp.token, channel);
      return {
        config: { type: 'http', name: 'ra-fusion', url: `http://127.0.0.1:${mcp.port}/${mcp.token}`, headers: [] },
        requests: () => [...channel.pending.values()].map(row => row.native),
        reply: (id, result) => this.reply(channel, id, result),
        close: async () => {
          if (channel.closed) return;
          channel.closed = true;
          for (const pending of channel.pending.values()) pending.response.destroy();
          channel.pending.clear(); entry.channels.delete(mcp.token);
          await release();
        },
      };
    } catch (error) { await release(); throw error; }
  }
  send(response, id, result, error) {
    return new Promise((resolve, reject) => {
      response.once('error', reject);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }), resolve);
    });
  }
  async receive(entry, request, response) {
    if (request.headers.origin && request.headers.origin !== `http://127.0.0.1:${entry.port}`) {
      response.writeHead(403); response.end(); return;
    }
    const channel = entry.channels.get(request.url.slice(1));
    if (!channel) { response.writeHead(404); response.end(); return; }
    if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
    let message;
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { id, method, params } = message;
      if (method === 'notifications/cancelled') {
        for (const [key, pending] of channel.pending) if (pending.id === params.requestId) {
          pending.response.destroy(); channel.pending.delete(key); channel.changed();
        }
        response.writeHead(202); response.end(); return;
      }
      if (id === undefined) { response.writeHead(202); response.end(); return; }
      if (method === 'initialize') return await this.send(response, id, {
        protocolVersion: params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'Remote Agent Fusion', version: '1' }, instructions: channel.instructions,
      });
      if (method === 'ping') return await this.send(response, id, {});
      if (method === 'tools/list') return await this.send(response, id, {
        tools: channel.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      if (method !== 'tools/call') return await this.send(response, id, null, { code: -32601, message: 'Unknown MCP method' });
      if (!channel.tools.some(tool => tool.name === params.name)) throw new Error('没有登记这个主控工具');
      const native = await channel.identify({ tool: params.name, arguments: params.arguments });
      if (channel.closed || response.destroyed) { response.destroy(); return; }
      const key = String(native.id), claim = JSON.stringify([native.params.threadId, native.params.turnId, native.params.callId, native.id]);
      if (channel.pending.has(key) || channel.claimed.has(claim)) throw new Error('这个原生工具请求已经认领，不会重复执行');
      channel.claimed.add(claim);
      channel.pending.set(key, { id, response, native });
      response.once('close', () => {
        if (channel.pending.get(key)?.response === response) { channel.pending.delete(key); channel.changed(); }
      });
      channel.changed();
    } catch (error) {
      if (!response.destroyed) await this.send(response, message?.id ?? null, null, { code: -32603, message: error.message });
    }
  }
  async reply(channel, id, result) {
    const key = String(id), pending = channel.pending.get(key);
    if (!pending) throw new Error('原生 MCP 请求已结束，未回复其他请求');
    channel.pending.delete(key);
    await this.send(pending.response, pending.id, {
      content: result.contentItems.map(item => ({ type: 'text', text: item.text })), isError: !result.success,
    });
  }
}

export const fusionMcp = new FusionMcpServer();
