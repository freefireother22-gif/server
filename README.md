# WebRTC WebSocket Signaling Server

Production-grade Node.js WebSocket signaling server for Parent–Child screen and one-way audio streaming.

## Features
- Full authenticated WebSocket message routing matching:
  - `pairingId`
  - `sessionId`
  - `negotiationId`
  - `senderDeviceId`
  - `targetDeviceId`
  - `messageId`
- Supported signaling events:
  - `START_SCREEN`, `STOP_SCREEN`
  - `START_AUDIO`, `STOP_AUDIO`
  - `WEBRTC_OFFER`, `WEBRTC_ANSWER`
  - `ICE_CANDIDATE`
  - `RESTART_ICE`
  - `FORCE_RELAY_MODE`
  - `HEARTBEAT` (ping/pong)
  - `REGISTER` / `REGISTERED`
  - `ACK` / `ERROR`
- Fast keep-alive heartbeat sweeps (25s) to tear down dead sockets and cleanly handle client reconnection.
- HTTP health check route: `GET /health`

---

## Ubuntu Deployment Instructions

### 1. Prerequisites (Ubuntu 20.04 / 22.04 / 24.04 LTS)
```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# Verify installation
node -v
npm -v
```

### 2. Copy and Install Dependencies
```bash
# Create application directory
sudo mkdir -p /opt/webrtc-signaling
sudo chown -R $USER:$USER /opt/webrtc-signaling

# Copy server files into /opt/webrtc-signaling
cd /opt/webrtc-signaling
# (Place server.js and package.json here)

# Install production dependencies
npm install --omit=dev
```

### 3. Run with systemd Service
Create `/etc/systemd/system/webrtc-signaling.service`:
```ini
[Unit]
Description=WebRTC Signaling Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/webrtc-signaling
ExecStart=/usr/bin/node /opt/webrtc-signaling/server.js
Restart=always
RestartSec=5
Environment=PORT=8080
Environment=HOST=0.0.0.0

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable webrtc-signaling
sudo systemctl start webrtc-signaling
sudo systemctl status webrtc-signaling
```

### 4. Setup SSL/TLS Reverse Proxy with Nginx & Certbot (for wss://)
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Configure `/etc/nginx/sites-available/signaling`:
```nginx
server {
    server_name signaling.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

Enable site & obtain TLS certificate:
```bash
sudo ln -s /etc/nginx/sites-available/signaling /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d signaling.yourdomain.com
```

Your secure WebSocket URL will be:
`wss://signaling.yourdomain.com/ws`

Set this in your Android `.env` file:
```properties
SIGNALING_WSS_URL=wss://signaling.yourdomain.com/ws
```
