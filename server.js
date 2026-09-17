/**
 * WebRTC Signaling Server for Parental Control Screen & Audio Mirroring.
 *
 * Supports:
 * - START_SCREEN, STOP_SCREEN
 * - START_AUDIO, STOP_AUDIO
 * - WEBRTC_OFFER, WEBRTC_ANSWER
 * - ICE_CANDIDATE
 * - RESTART_ICE
 * - FORCE_RELAY_MODE
 * - HEARTBEAT, reconnect, and acknowledgement
 *
 * Routing key:
 *   pairingId, sessionId, negotiationId, senderDeviceId, targetDeviceId, messageId
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PING_INTERVAL_MS = 25000;

// Device map: deviceId -> WebSocket connection
const clients = new Map();
// Reverse map: WebSocket connection -> Set<deviceId>
const socketToDevices = new WeakMap();

// HTTP server for health checks & WebSocket upgrades
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      activeDevices: clients.size,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: Date.now()
    }));
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  // Allow all paths or /ws
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  socketToDevices.set(ws, new Set());

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    try {
      const text = raw.toString('utf8').trim();
      if (!text) return;
      const data = JSON.parse(text);

      handleIncomingMessage(ws, data);
    } catch (err) {
      console.error('[SignalingServer] Malformed message error:', err.message);
      safeSend(ws, {
        type: 'ERROR',
        error: 'Malformed JSON message',
        timestamp: Date.now()
      });
    }
  });

  ws.on('close', (code, reason) => {
    cleanupSocket(ws, `code=${code}`);
  });

  ws.on('error', (err) => {
    console.warn('[SignalingServer] Socket error:', err.message);
    cleanupSocket(ws, `error=${err.message}`);
  });
});

function handleIncomingMessage(ws, msg) {
  const type = msg.type || msg.messageType;
  if (!type) {
    safeSend(ws, { type: 'ERROR', error: 'Missing message type', timestamp: Date.now() });
    return;
  }

  // 1. Device Registration / Auth / Join
  if (type === 'REGISTER' || type === 'DEVICE_ONLINE') {
    const deviceId = msg.deviceId || msg.senderDeviceId;
    if (!deviceId) {
      safeSend(ws, { type: 'ERROR', error: 'Missing deviceId in register', timestamp: Date.now() });
      return;
    }

    const previousWs = clients.get(deviceId);
    if (previousWs && previousWs !== ws) {
      console.log(`[SignalingServer] Device ${deviceId} reconnecting from new connection. Closing previous.`);
      try {
        previousWs.close(1000, 'Replaced by new connection');
      } catch (_) {}
    }

    clients.set(deviceId, ws);
    const set = socketToDevices.get(ws) || new Set();
    set.add(deviceId);
    socketToDevices.set(ws, set);

    console.log(`[SignalingServer] Device registered: ${deviceId} (Total active: ${clients.size})`);

    // Acknowledge registration
    safeSend(ws, {
      type: 'REGISTERED',
      deviceId,
      messageId: msg.messageId || null,
      timestamp: Date.now()
    });
    return;
  }

  // 2. Heartbeat Ping / Pong
  if (type === 'HEARTBEAT' || type === 'PING') {
    ws.isAlive = true;
    safeSend(ws, {
      type: 'HEARTBEAT_ACK',
      timestamp: Date.now(),
      messageId: msg.messageId || null
    });
    return;
  }

  // 3. Routed Signaling Messages:
  // START_SCREEN, STOP_SCREEN, START_AUDIO, STOP_AUDIO,
  // WEBRTC_OFFER, WEBRTC_ANSWER, ICE_CANDIDATE, RESTART_ICE, FORCE_RELAY_MODE, etc.
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

  // Envelope forwarded to target
  const forwardedMessage = {
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
  };

  safeSend(targetWs, forwardedMessage);

  // Send ACK back to sender confirming server receipt and forwarding
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

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      console.error('[SignalingServer] Error sending payload:', e.message);
    }
  }
}

function cleanupSocket(ws, reason) {
  const registered = socketToDevices.get(ws);
  if (registered) {
    for (const devId of registered) {
      if (clients.get(devId) === ws) {
        clients.delete(devId);
        console.log(`[SignalingServer] Cleaned up device ${devId} (${reason}). Remaining active: ${clients.size}`);
      }
    }
    registered.clear();
  }
}

// Keep-alive heartbeat sweep
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[SignalingServer] Terminating dead client connection (missed ping/pong)');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(interval);
});

server.listen(PORT, HOST, () => {
  console.log(`[SignalingServer] WebRTC signaling WebSocket server running on http://${HOST}:${PORT} (ws://${HOST}:${PORT}/ws)`);
});
