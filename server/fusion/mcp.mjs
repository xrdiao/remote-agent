import http from 'node:http';
import crypto from 'node:crypto';

// MCP is a native tool transport. The existing Runner owns all decisions/state.
export class FusionMcpServer {
  constructor() { this.bindings = new Map(); }
  async bind(binding, { tools, instructions, identify, changed }) {
    if (!this.server) {
      this.server = http.createServer((request, response) => this.receive(request, response));
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(binding.mcp?.port || 0, '127.0.0.1', resolve);
      });
      this.server.unref();
    }
    binding.mcp ||= { token: crypto.randomBytes(24).toString('hex'), port: this.server.address().port };
    const channel = this.bindings.get(binding.mcp.token) || { pending: new Map() };
    Object.assign(channel, { binding, tools, instructions, identify, changed });
    this.bindings.set(binding.mcp.token, channel);
    const url = `http://127.0.0.1:${binding.mcp.port}/${binding.mcp.token}`;
    return {
      config: { type: 'http', name: 'ra-fusion', url, headers: [] },
      requests: () => [...channel.pending.values()].map(row => row.native),
      reply: (id, result) => this.reply(channel, id, result),
      close: async () => {
        for (const pending of channel.pending.values()) pending.response.destroy();
        channel.pending.clear(); this.bindings.delete(binding.mcp.token);
        if (!this.bindings.size) {
          const server = this.server;
          await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          this.server = null;
        }
      },
    };
  }
  send(response, id, result, error) {
    return new Promise((resolve, reject) => {
      response.once('error', reject);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }), resolve);
    });
  }
  async receive(request, response) {
    if (request.headers.origin && request.headers.origin !== `http://127.0.0.1:${this.server.address().port}`) {
      response.writeHead(403); response.end(); return;
    }
    const channel = this.bindings.get(request.url.slice(1));
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
      const key = String(native.id);
      if (channel.pending.has(key)) throw new Error('这个原生工具请求仍在等待回执');
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
