#!/bin/bash

# TURN Server (Coturn) 설치 스크립트
# Ubuntu 22.04+ 에서 실행

set -e

echo "=================================="
echo "TURN Server (Coturn) Installation"
echo "=================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root or with sudo"
  exit 1
fi

# Variables
TURN_USER=${TURN_USER:-"turnuser"}
TURN_PASSWORD=${TURN_PASSWORD:-"$(openssl rand -base64 32)"}
TURN_REALM=${TURN_REALM:-"turn.vshot.example.com"}
EXTERNAL_IP=$(curl -s ifconfig.me)
INTERNAL_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "Configuration:"
echo "  External IP: $EXTERNAL_IP"
echo "  Internal IP: $INTERNAL_IP"
echo "  Realm: $TURN_REALM"
echo "  Username: $TURN_USER"
echo "  Password: $TURN_PASSWORD"
echo ""
read -p "Continue with these settings? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

# 1. Install coturn
echo "[1/6] Installing coturn..."
apt-get update
apt-get install -y coturn

# 2. Backup original config
echo "[2/6] Backing up original config..."
if [ ! -f /etc/turnserver.conf.backup ]; then
  cp /etc/turnserver.conf /etc/turnserver.conf.backup
fi

# 3. Create turnserver config
echo "[3/6] Creating turnserver configuration..."
cat > /etc/turnserver.conf << EOF
# VShot v2 TURN Server Configuration

# Listening port
listening-port=3478
tls-listening-port=5349

# Listening IPs
listening-ip=$INTERNAL_IP
relay-ip=$INTERNAL_IP

# External IP
external-ip=$EXTERNAL_IP

# Relay configuration
min-port=49152
max-port=65535

# Authentication
realm=$TURN_REALM
user=$TURN_USER:$TURN_PASSWORD

# Security
fingerprint
lt-cred-mech

# Optimization
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1

# Logging
verbose
log-file=/var/log/turnserver.log

# Deny private IPs (security)
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255

# Allow loopback for testing
no-loopback-peers

# Quotas
user-quota=0
total-quota=0
bps-capacity=0

# Misc
no-stun-backward-compatibility
response-origin-only-with-rfc5780
EOF

# 4. Enable coturn service
echo "[4/6] Enabling coturn service..."
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn

# 5. Configure firewall
echo "[5/6] Configuring firewall..."
if command -v ufw &> /dev/null; then
  ufw allow 3478/tcp
  ufw allow 3478/udp
  ufw allow 5349/tcp
  ufw allow 5349/udp
  ufw allow 49152:65535/tcp
  ufw allow 49152:65535/udp
  echo "Firewall rules added"
fi

# 6. Start service
echo "[6/6] Starting coturn service..."
systemctl restart coturn
systemctl enable coturn

# Wait for service to start
sleep 3

# Check service status
if systemctl is-active --quiet coturn; then
  echo ""
  echo "=================================="
  echo "✅ TURN Server installed successfully!"
  echo "=================================="
  echo ""
  echo "Server Information:"
  echo "  TURN URL: turn:$EXTERNAL_IP:3478"
  echo "  TURNS URL: turns:$EXTERNAL_IP:5349"
  echo "  Username: $TURN_USER"
  echo "  Password: $TURN_PASSWORD"
  echo "  Realm: $TURN_REALM"
  echo ""
  echo "Add to your .env file:"
  echo "  TURN_SERVER_URL=turn:$EXTERNAL_IP:3478"
  echo "  TURN_USERNAME=$TURN_USER"
  echo "  TURN_CREDENTIAL=$TURN_PASSWORD"
  echo ""
  echo "Useful commands:"
  echo "  systemctl status coturn  # Check service status"
  echo "  journalctl -u coturn -f  # View logs"
  echo "  tail -f /var/log/turnserver.log  # View TURN logs"
  echo ""
else
  echo ""
  echo "=================================="
  echo "❌ TURN Server failed to start"
  echo "=================================="
  echo ""
  echo "Check logs:"
  echo "  journalctl -u coturn -n 50"
  echo "  tail -f /var/log/turnserver.log"
  exit 1
fi
