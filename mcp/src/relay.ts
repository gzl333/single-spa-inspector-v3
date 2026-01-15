import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import {
  getRelayPort,
  getRelayToken,
  getCdpUrl,
  getAllowedExtensionIds,
  isLocalhost,
  log,
  error,
  VERSION,
} from './utils.js';
import type { ExtensionMessage } from './protocol.js';

interface CDPClient {
  ws: WebSocket;
}

interface PendingRequest {
  clientId: string;
  clientMessageId: number;
  sessionId?: string;
}

interface TargetInfo {
  targetId?: string;
  title?: string;
  url?: string;
  type?: string;
}

interface AttachedTarget {
  sessionId: string;
  tabId?: number;
  targetInfo?: TargetInfo;
}

const app = new Hono();

let extensionWs: WebSocket | null = null;
const cdpClients = new Map<string, CDPClient>();
const attachedTargets = new Map<string, AttachedTarget>();
const pendingRequests = new Map<number, PendingRequest>();
let nextExtensionRequestId = 1;

const ALLOWED_EXTENSION_IDS = getAllowedExtensionIds();
if (ALLOWED_EXTENSION_IDS.length === 0) {
  error('No SSPA_EXTENSION_IDS configured. Extension connections will be rejected.');
}

app.use(cors());

app.get('/', (c) => {
  return c.text('OK');
});

app.get('/version', (c) => {
  return c.json({ version: VERSION });
});

app.get('/json/version', (c) => {
  const port = getRelayPort();
  return c.json({
    Browser: `single-spa-inspector-pro/${VERSION}`,
    'Protocol-Version': '1.3',
    webSocketDebuggerUrl: getCdpUrl(port),
  });
});

app.get('/json/list', (c) => {
  const targets = Array.from(attachedTargets.values()).map((target) => {
    const targetInfo = target.targetInfo ?? {};
    return {
      id: targetInfo.targetId ?? target.sessionId,
      tabId: target.tabId,
      type: targetInfo.type ?? 'page',
      title: targetInfo.title ?? '',
      url: targetInfo.url ?? '',
      webSocketDebuggerUrl: getCdpUrl(getRelayPort(), target.sessionId),
    };
  });
  return c.json(targets);
});

function sendToExtension(message: unknown): void {
  if (extensionWs?.readyState === WebSocket.OPEN) {
    extensionWs.send(JSON.stringify(message));
  } else {
    error('Extension WebSocket not connected, cannot send message');
  }
}

function sendToCDPClient(clientId: string, message: unknown): void {
  const client = cdpClients.get(clientId);
  if (client?.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(message));
  }
}

function broadcastToCDPClients(message: unknown): void {
  for (const client of cdpClients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }
}

function validateExtensionOrigin(origin: string | null): boolean {
  if (!origin) return false;
  const match = origin.match(/^chrome-extension:\/\/([^/]+)/);
  if (!match) return false;
  const id = match[1];
  return ALLOWED_EXTENSION_IDS.includes(id);
}

function handleExtensionMessage(data: Buffer) {
  try {
    const message = JSON.parse(data.toString()) as ExtensionMessage;

    if (message.method === 'pong') {
      log('Received pong from extension');
      return;
    }

    if (message.method === 'log') {
      log(`[EXT LOG ${message.params.level}]`, ...message.params.args);
      return;
    }

    if (message.method === 'forwardCDPEvent') {
      const { sessionId, method, params } = message.params;

      if (method === 'Target.attachedToTarget' && sessionId) {
        const targetInfo = (params as { targetInfo?: TargetInfo }).targetInfo;
        attachedTargets.set(sessionId, {
          sessionId,
          targetInfo,
        });
      }

      if (method === 'Target.detachedFromTarget') {
        const detachedSessionId = (params as { sessionId?: string }).sessionId;
        if (detachedSessionId) {
          attachedTargets.delete(detachedSessionId);
        }
      }

      broadcastToCDPClients({ method, params, sessionId });
      return;
    }

    if ('id' in message) {
      const response = message as { id: number; result?: unknown; error?: string };
      const pending = pendingRequests.get(response.id);
      if (!pending) {
        error(`Received response for unknown request id: ${response.id}`);
        return;
      }

      pendingRequests.delete(response.id);
      const payload = response.error
        ? { id: pending.clientMessageId, sessionId: pending.sessionId, error: { message: response.error } }
        : { id: pending.clientMessageId, sessionId: pending.sessionId, result: response.result };

      sendToCDPClient(pending.clientId, payload);
    }
  } catch (e) {
    error('Error parsing extension message:', e);
  }
}

function handleCDPMessage(data: Buffer, clientId: string) {
  try {
    const message = JSON.parse(data.toString()) as { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string } | { method: 'forwardCDPCommand'; params: { method: string; sessionId?: string; params?: Record<string, unknown> }; id?: number };

    if (message.method === 'forwardCDPCommand') {
      const { params, id } = message;
      if (!params?.method || !id) {
        return;
      }
      const relayId = nextExtensionRequestId++;
      pendingRequests.set(relayId, {
        clientId,
        clientMessageId: id,
        sessionId: params.sessionId,
      });
      sendToExtension({
        id: relayId,
        method: 'forwardCDPCommand',
        params,
      });
      return;
    }

    if (!message.method || message.id === undefined) {
      return;
    }

    const relayId = nextExtensionRequestId++;
    pendingRequests.set(relayId, {
      clientId,
      clientMessageId: message.id,
      sessionId: message.sessionId,
    });

    sendToExtension({
      id: relayId,
      method: 'forwardCDPCommand',
      params: {
        method: message.method,
        sessionId: message.sessionId,
        params: message.params,
      },
    });
  } catch (e) {
    error('Error parsing CDP message:', e);
  }
}

export async function startRelayServer(): Promise<void> {
  const port = getRelayPort();

  const server = http.createServer(async (req, res) => {
    try {
      const response = await app.fetch(req as unknown as Request, {} as never);
      response?.text().then((text) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(text);
      }).catch(() => {
        res.writeHead(500);
        res.end('Error');
      });
    } catch {
      res.writeHead(500);
      res.end('Error');
    }
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const remoteAddr = req.socket?.remoteAddress || '';
    const origin = req.headers.origin || '';

    if (!isLocalhost(remoteAddr)) {
      error(`Rejected connection from non-localhost: ${remoteAddr}`);
      ws.close(1008, 'Connection only allowed from localhost');
      return;
    }

    const pathname = req.url?.split('?')[0] || '';

    if (pathname === '/extension') {
      if (!validateExtensionOrigin(origin)) {
        error(`Rejected extension connection with invalid origin: ${origin}`);
        ws.close(1008, 'Invalid origin');
        return;
      }

      log('Extension WebSocket connected');
      extensionWs = ws as WebSocket;

      ws.on('message', (data) => {
        if (Buffer.isBuffer(data)) {
          handleExtensionMessage(data);
        }
      });

      ws.on('close', () => {
        log('Extension WebSocket disconnected');
        if (extensionWs === ws) {
          extensionWs = null;
        }
        attachedTargets.clear();
        pendingRequests.clear();
      });

      ws.on('error', (err) => {
        error('Extension WebSocket error:', err.message);
      });
      return;
    }

    if (pathname.startsWith('/cdp/')) {
      const clientId = pathname.slice(5);
      const token = getRelayToken();

      if (token) {
        const url = new URL(req.url || '', `http://localhost:${port}`);
        const providedToken = url.searchParams.get('token');
        if (providedToken !== token) {
          error('Rejected CDP connection with invalid token');
          ws.close(1008, 'Invalid token');
          return;
        }
      }

      log(`CDP WebSocket connected: ${clientId}`);

      cdpClients.set(clientId, {
        ws: ws as WebSocket,
      });

      ws.on('message', (data) => {
        if (Buffer.isBuffer(data)) {
          handleCDPMessage(data, clientId);
        }
      });

      ws.on('close', () => {
        log(`CDP WebSocket disconnected: ${clientId}`);
        cdpClients.delete(clientId);
      });

      ws.on('error', (err) => {
        error(`CDP WebSocket error (${clientId}):`, err.message);
      });

      ws.send(JSON.stringify({ method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false } }));
      return;
    }

    ws.close(1008, 'Unknown endpoint');
  });

  server.listen(port, () => {
    log(`Relay server started on port ${port}`);
    log(`Extension endpoint: ws://localhost:${port}/extension`);
    log(`CDP endpoint: ws://localhost:${port}/cdp/:clientId`);
  });

  setInterval(() => {
    if (extensionWs?.readyState === WebSocket.OPEN) {
      extensionWs.send(JSON.stringify({ method: 'ping' }));
    }
  }, 30000);
}

startRelayServer().catch((e) => {
  error('Failed to start relay server:', e);
  process.exit(1);
});
