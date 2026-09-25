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
const { getSupabase, verifyFirebaseBearer } = require('./lib/platform');
const { requireFeature } = require('./lib/entitlements');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PING_INTERVAL_MS = 25000;

// Device map: deviceId -> WebSocket connection
const clients = new Map();
// Reverse map: WebSocket connection -> Set<deviceId>
const socketToDevices = new WeakMap();
const socketDeviceAuth = new WeakMap();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if ((req.method === 'GET' && url.pathname === '/health') ||
        (req.method === 'GET' && url.pathname === '/')) {
      // Keep the public health response minimal. Detailed platform diagnostics
      // must not disclose database or Firebase configuration to the internet.
      sendJson(res, 200, { status: 'ok' });
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
  const upgradeUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (upgradeUrl.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  socketToDevices.set(ws, new Set());
  socketDeviceAuth.set(ws, new Map());

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    Promise.resolve().then(async () => {
      const text = raw.toString('utf8').trim();
      if (!text) return;
      await handleIncomingMessage(ws, JSON.parse(text));
    }).catch((error) => {
      console.error('[SignalingServer] Message error:', error.message);
      safeSend(ws, {
        type: 'ERROR',
        error: error.statusCode ? error.message : 'Malformed JSON message',
        timestamp: Date.now()
      });
    });
  });

  ws.on('close', (code) => cleanupSocket(ws, `code=${code}`));
  ws.on('error', (error) => {
    console.warn('[SignalingServer] Socket error:', error.message);
    cleanupSocket(ws, `error=${error.message}`);
  });
});

async function authenticateDevice(deviceId, firebaseToken) {
  if (!firebaseToken) {
    const error = new Error('Firebase authentication is required for signaling');
    error.statusCode = 401;
    throw error;
  }
  const decoded = await verifyFirebaseBearer(`Bearer ${firebaseToken}`);
  const { data: device, error: deviceError } = await getSupabase()
    .from('device_registry')
    .select('*')
    .eq('device_id', deviceId)
    .eq('firebase_uid', decoded.uid)
    .maybeSingle();
  if (deviceError) throw new Error(`Device authentication lookup failed: ${deviceError.message}`);
  if (!device) {
    const error = new Error('Device is not registered for this Firebase account');
    error.statusCode = 403;
    throw error;
  }

  let ownerUid = device.role === 'parent' ? decoded.uid : device.owner_firebase_uid;
  if (device.role === 'child' && !ownerUid && device.pairing_id) {
    const parent = await getSupabase()
      .from('device_registry')
      .select('firebase_uid, owner_firebase_uid')
      .eq('pairing_id', device.pairing_id)
      .eq('role', 'parent')
      .maybeSingle();
    if (!parent.error && parent.data) {
      ownerUid = parent.data.owner_firebase_uid || parent.data.firebase_uid;
    }
  }
  if (!ownerUid) {
    const error = new Error('Device has no verified parent subscription owner');
    error.statusCode = 403;
    throw error;
  }
  await requireFeature(ownerUid, 'PARENTAL_CONTROL');
  return { uid: decoded.uid, ownerUid, device };
}

async function handleIncomingMessage(ws, msg) {
  const type = msg.type || msg.messageType;
  if (!type) {
    safeSend(ws, { type: 'ERROR', error: 'Missing message type', timestamp: Date.now() });
    return;
  }

  if (type === 'REGISTER' || type === 'DEVICE_ONLINE') {
    const deviceId = msg.deviceId || msg.senderDeviceId;
    if (!deviceId) {
      safeSend(ws, { type: 'ERROR', error: 'Missing deviceId in register', timestamp: Date.now() });
      return;
    }
    const auth = await authenticateDevice(deviceId, msg.firebaseToken);

    const previousWs = clients.get(deviceId);
    if (previousWs && previousWs !== ws) {
      console.log(`[SignalingServer] Device ${deviceId} reconnecting. Closing previous connection.`);
      try { previousWs.close(1000, 'Replaced by new connection'); } catch (_) {}
    }

    clients.set(deviceId, ws);
    const registered = socketToDevices.get(ws) || new Set();
    registered.add(deviceId);
    socketToDevices.set(ws, registered);
    socketDeviceAuth.get(ws).set(deviceId, auth);

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

  const registeredDevices = socketToDevices.get(ws) || new Set();
  const authenticated = socketDeviceAuth.get(ws)?.get(senderDeviceId);
  if (!senderDeviceId || !registeredDevices.has(senderDeviceId)) {
    console.warn(`[SignalingServer] Rejected ${type}: senderDeviceId is not registered on this socket`);
    safeSend(ws, {
      type: 'ERROR',
      error: 'Sender device is not registered on this socket',
      messageId,
      timestamp: Date.now()
    });
    return;
  }
  if (!authenticated) {
    safeSend(ws, { type: 'ERROR', error: 'Signaling authentication is required', messageId, timestamp: Date.now() });
    return;
  }

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
  const targetAuth = socketDeviceAuth.get(targetWs)?.get(targetDeviceId);
  const senderDevice = authenticated.device;
  const targetDevice = targetAuth?.device;
  if (!targetDevice || !senderDevice.pairing_id || !targetDevice.pairing_id ||
      (pairingId && senderDevice.pairing_id !== pairingId) ||
      senderDevice.pairing_id !== targetDevice.pairing_id) {
    safeSend(ws, {
      type: 'ERROR',
      error: 'Sender and target devices are not in the same verified pairing',
      messageId,
      timestamp: Date.now()
    });
    return;
  }

  const requiredFeature = {
    START_SCREEN: 'SCREEN_MIRRORING',
    START_CAMERA: 'REMOTE_CAMERA',
    START_AUDIO: 'ONE_WAY_AUDIO',
    APP_BLOCK_RULES_UPDATE: 'APP_LOCKING',
    MONITORING_SNAPSHOT: 'PARENTAL_CONTROL',
    MONITORING_LOCATION: 'LIVE_LOCATION'
  }[type];
  if (requiredFeature) {
    try {
      await requireFeature(authenticated.ownerUid, requiredFeature);
    } catch (error) {
      safeSend(ws, {
        type: 'ERROR',
        error: error.message,
        code: error.code || 'PAID_PLAN_REQUIRED',
        messageId,
        timestamp: Date.now()
      });
      return;
    }
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
  socketDeviceAuth.delete(ws);
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
