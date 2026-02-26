const WebSocket = require('ws');
const EventEmitter = require('events');

class WebSocketServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 8080;
    this.wss = null;
    this.clients = new Map();
    this.subscriptions = new Map();
  }

  async start() {
    this.wss = new WebSocket.Server({ port: this.port });
    
    this.wss.on('connection', (ws, req) => {
      const clientId = `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      this.clients.set(clientId, { ws, subscriptions: new Set() });
      
      console.log(`[WebSocket] Client connected: ${clientId}`);
      
      ws.send(JSON.stringify({ type: 'connected', clientId, timestamp: Date.now() }));
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          this.handleMessage(clientId, message);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
        }
      });
      
      ws.on('close', () => {
        console.log(`[WebSocket] Client disconnected: ${clientId}`);
        this.clients.delete(clientId);
      });
      
      ws.on('error', (err) => {
        console.error(`[WebSocket] Client error: ${clientId}`, err.message);
        this.clients.delete(clientId);
      });
    });
    
    console.log(`[WebSocket] Server started on port ${this.port}`);
    return this;
  }

  handleMessage(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    switch (message.type) {
      case 'subscribe':
        if (message.channel) {
          client.subscriptions.add(message.channel);
          client.ws.send(JSON.stringify({ type: 'subscribed', channel: message.channel }));
        }
        break;
      case 'unsubscribe':
        if (message.channel) {
          client.subscriptions.delete(message.channel);
          client.ws.send(JSON.stringify({ type: 'unsubscribed', channel: message.channel }));
        }
        break;
      case 'ping':
        client.ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      default:
        this.emit('message', { clientId, message });
    }
  }

  broadcast(channel, data) {
    const message = JSON.stringify({ type: 'data', channel, data, timestamp: Date.now() });
    
    for (const [clientId, client] of this.clients) {
      if (client.subscriptions.has(channel) || client.subscriptions.has('all')) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(message);
        }
      }
    }
  }

  sendToClient(clientId, data) {
    const client = this.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: 'data', ...data, timestamp: Date.now() }));
    }
  }

  stop() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.clients.clear();
  }
}

module.exports = WebSocketServer;
