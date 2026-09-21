'use strict';

/**
 * ParentGuard backend:
 * - Existing WebRTC WebSocket signaling remains compatible.
 * - Secure Firebase-authenticated HTTP APIs manage trials, plans and bans.
 * - Supabase stores users, subscriptions and audit logs.
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { handleApi, sendJson } = require('./lib/api');
const { platformHealth } = require('./lib/platform');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PING_INTERVAL_MS = 25000;

// Device map: deviceId -> WebSocket connection
const clients = new Map();
// Reverse map: WebSocket connection -> Set<deviceId>
const socketToDevices = new WeakMap();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if ((req.method === 'GET' && url.pathname === '/health') ||
        (req.method === 'GET' && url.pathname === '/')) {
      const platform = await platformHealth();
      sendJson(res, 200, {
        status: 'ok',
        activeDevices: clients.size,
        uptimeSec: Math.floor(process.uptime()),
        timestamp: Date.now(),
        platform
      });
      return;
    }

    const handled = await handleApi(req, res, url);
    if (!handled) sendJson(res, 404, { ok: false, error: 'Not Found' });
  } catch (error) {
    console.error('[HTTPServer] Unhandled request error:', error);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Server request failed' });
    else res.end();
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  // Existing Android apps connect to /ws. Keep backward compatibility.
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  socketToDevices.set(ws, new Set());

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    try {
      const text = raw.toString('utf8').trim();
      if (!text) return;
      handleIncomingMessage(ws, JSON.parse(text));
    } catch (error) {
      console.error('[SignalingServer] Malformed message error:', error.message);
      safeSend(ws, {
        type: 'ERROR',
        error: 'Malformed JSON message',
        timestamp: Date.now()
      });
    }
  });

  ws.on('close', (code) => cleanupSocket(ws, `code=${code}`));
  ws.on('error', (error) => {
    console.warn('[SignalingServer] Socket error:', error.message);
    cleanupSocket(ws, `error=${error.message}`);
  });
});

function handleIncomingMessage(ws, msg) {
  const type = msg.type || msg.messageType;
  if (!type) {
    safeSend(ws, { type: 'ERROR', error: 'Missing message type', timestamp: Date.now() });
    return;
  }

  // Existing device registration stays compatible with the current apps.
  // Firebase-token enforcement for WebSocket registration should be enabled
  // only after both Parent and Child apps send tokens during REGISTER.
  if (type === 'REGISTER' || type === 'DEVICE_ONLINE') {
    const deviceId = msg.deviceId || msg.senderDeviceId;
    if (!deviceId) {
      safeSend(ws, { type: 'ERROR', error: 'Missing deviceId in register', timestamp: Date.now() });
      return;
    }

    const previousWs = clients.get(deviceId);
    if (previousWs && previousWs !== ws) {
      console.log(`[SignalingServer] Device ${deviceId} reconnecting. Closing previous connection.`);
      try { previousWs.close(1000, 'Replaced by new connection'); } catch (_) {}
    }

    clients.set(deviceId, ws);
    const registered = socketToDevices.get(ws) || new Set();
    registered.add(deviceId);
    socketToDevices.set(ws, registered);

    console.log(`[SignalingServer] Device registered: ${deviceId} (Total active: ${clients.size})`);
    safeSend(ws, {
      type: 'REGISTERED',
      deviceId,
      messageId: msg.messageId || null,
      timestamp: Date.now()
    });
    return;
  }

  if (type === 'HEARTBEAT' || type === 'PING') {
    ws.isAlive = true;
    safeSend(ws, {
      type: 'HEARTBEAT_ACK',
      timestamp: Date.now(),
      messageId: msg.messageId || null
    });
    return;
  }

  const {
    pairingId = '',
    sessionId = '',
    negotiationId = '',
    senderDeviceId = '',
    targetDeviceId = '',
    messageId = '',
    payload = ''
  } = msg;

  if (!targetDeviceId) {
    console.warn(`[SignalingServer] Message ${type} rejected: missing targetDeviceId from ${senderDeviceId}`);
    safeSend(ws, {
      type: 'ERROR',
      error: 'Missing targetDeviceId',
      messageId,
      timestamp: Date.now()
    });
    return;
  }

  const targetWs = clients.get(targetDeviceId);
  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    console.log(`[SignalingServer] Target ${targetDeviceId} offline for ${type} (msgId=${messageId})`);
    safeSend(ws, {
      type: 'TARGET_OFFLINE',
      targetDeviceId,
      messageId,
      timestamp: Date.now()
    });
    return;
  }

  safeSend(targetWs, {
    type,
    messageType: type,
    pairingId,
    sessionId,
    negotiationId,
    senderDeviceId,
    targetDeviceId,
    messageId,
    payload,
    timestamp: msg.timestamp || Date.now()
  });

  if (messageId) {
    safeSend(ws, {
      type: 'ACK',
      messageId,
      targetDeviceId,
      timestamp: Date.now()
    });
  }

  console.log(`[SignalingServer] Forwarded ${type} from ${senderDeviceId} -> ${targetDeviceId} [negId=${negotiationId || '-'}]`);
}

function safeSend(ws, object) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(object));
    } catch (error) {
      console.error('[SignalingServer] Error sending payload:', error.message);
    }
  }
}

function cleanupSocket(ws, reason) {
  const registered = socketToDevices.get(ws);
  if (!registered) return;

  for (const deviceId of registered) {
    if (clients.get(deviceId) === ws) {
      clients.delete(deviceId);
      console.log(`[SignalingServer] Cleaned up device ${deviceId} (${reason}). Remaining: ${clients.size}`);
    }
  }
  registered.clear();
}

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[SignalingServer] Terminating dead client connection');
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, HOST, () => {
  console.log(`[ParentGuard] HTTP API listening on http://${HOST}:${PORT}`);
  console.log(`[ParentGuard] WebSocket signaling listening on ws://${HOST}:${PORT}/ws`);
  console.log(`[ParentGuard] Supabase configured: ${Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY))}`);
  console.log(`[ParentGuard] Firebase Admin configured: ${Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY))}`);
});
