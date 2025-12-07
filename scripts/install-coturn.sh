#!/bin/bash

# Coturn TURN Server Installation Script for Ubuntu 22+
# Run with: sudo bash install-coturn.sh

echo "================================================"
echo "  Installing Coturn TURN Server"
echo "================================================"

# Update system
apt-get update
apt-get upgrade -y

# Install Coturn
apt-get install -y coturn

# Enable Coturn service
echo "TURNSERVER_ENABLED=1" > /etc/default/coturn

# Get server IP
SERVER_IP=$(curl -s ifconfig.me)
echo "Server IP: $SERVER_IP"

# Backup original config
cp /etc/turnserver.conf /etc/turnserver.conf.backup

# Generate random credentials
TURN_USERNAME="vshot_$(openssl rand -hex 4)"
TURN_PASSWORD="$(openssl rand -base64 16)"

# Create Coturn configuration
cat > /etc/turnserver.conf <<EOF
# VShot v2 TURN Server Configuration

# Listening port
listening-port=3478
tls-listening-port=5349

# Relay ports range
min-port=49152
max-port=65535

# Server addresses
listening-ip=0.0.0.0
relay-ip=${SERVER_IP}
external-ip=${SERVER_IP}

# Realm
realm=vshot.local

# Authentication
lt-cred-mech
user=${TURN_USERNAME}:${TURN_PASSWORD}

# Security
fingerprint
no-loopback-peers
no-multicast-peers
stale-nonce

# Logging
log-file=/var/log/turnserver.log
verbose

# Performance
total-quota=100
bps-capacity=0

# TLS (optional - requires certificates)
# cert=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
# pkey=/etc/letsencrypt/live/yourdomain.com/privkey.pem
EOF

# Set permissions
chmod 644 /etc/turnserver.conf

# Create log file
touch /var/log/turnserver.log
chown turnserver:turnserver /var/log/turnserver.log

# Configure firewall (UFW)
if command -v ufw &> /dev/null; then
    echo "Configuring firewall..."
    ufw allow 3478/tcp
    ufw allow 3478/udp
    ufw allow 5349/tcp
    ufw allow 5349/udp
    ufw allow 49152:65535/tcp
    ufw allow 49152:65535/udp
    echo "Firewall configured"
fi

# Restart Coturn
systemctl restart coturn
systemctl enable coturn

echo ""
echo "================================================"
echo "  Coturn Installation Complete! 🎉"
echo "================================================"
echo ""
echo "Server IP: ${SERVER_IP}"
echo "TURN URL: turn:${SERVER_IP}:3478"
echo "Username: ${TURN_USERNAME}"
echo "Password: ${TURN_PASSWORD}"
echo ""
echo "Add these to your .env file:"
echo ""
echo "TURN_SERVER_URL=turn:${SERVER_IP}:3478"
echo "TURN_USERNAME=${TURN_USERNAME}"
echo "TURN_CREDENTIAL=${TURN_PASSWORD}"
echo ""
echo "Check status: systemctl status coturn"
echo "View logs: tail -f /var/log/turnserver.log"
echo ""
