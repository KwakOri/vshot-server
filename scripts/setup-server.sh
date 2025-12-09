#!/bin/bash

# Vultr 서버 초기 설정 스크립트
# Ubuntu 22.04+ 에서 실행

set -e

echo "=================================="
echo "VShot v2 Server Setup Script"
echo "=================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root or with sudo"
  exit 1
fi

# Variables
DEPLOY_USER=${DEPLOY_USER:-"vshot"}
DEPLOY_PATH=${DEPLOY_PATH:-"/opt/vshot"}
NODE_VERSION=${NODE_VERSION:-"20"}

echo ""
echo "Configuration:"
echo "  Deploy User: $DEPLOY_USER"
echo "  Deploy Path: $DEPLOY_PATH"
echo "  Node Version: $NODE_VERSION"
echo ""

# 1. Update system
echo "[1/7] Updating system packages..."
apt-get update
apt-get upgrade -y

# 2. Install Node.js
echo "[2/7] Installing Node.js $NODE_VERSION..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_$NODE_VERSION.x | bash -
  apt-get install -y nodejs
fi

node --version
npm --version

# 3. Create deployment user
echo "[3/7] Creating deployment user..."
if ! id "$DEPLOY_USER" &>/dev/null; then
  useradd -m -s /bin/bash $DEPLOY_USER
  echo "$DEPLOY_USER user created"
else
  echo "$DEPLOY_USER user already exists"
fi

# 4. Create deployment directory
echo "[4/7] Creating deployment directory..."
mkdir -p $DEPLOY_PATH
chown -R $DEPLOY_USER:$DEPLOY_USER $DEPLOY_PATH

# 5. Setup SSH for deployment
echo "[5/7] Setting up SSH access..."
mkdir -p /home/$DEPLOY_USER/.ssh
chmod 700 /home/$DEPLOY_USER/.ssh

echo "Please add your GitHub Actions public key to /home/$DEPLOY_USER/.ssh/authorized_keys"
echo "Example: echo 'ssh-rsa AAAA...' >> /home/$DEPLOY_USER/.ssh/authorized_keys"

touch /home/$DEPLOY_USER/.ssh/authorized_keys
chmod 600 /home/$DEPLOY_USER/.ssh/authorized_keys
chown -R $DEPLOY_USER:$DEPLOY_USER /home/$DEPLOY_USER/.ssh

# 6. Create systemd service
echo "[6/7] Creating systemd service..."
cat > /etc/systemd/system/vshot-signaling.service << EOF
[Unit]
Description=VShot v2 Signaling Server
After=network.target

[Service]
Type=simple
User=$DEPLOY_USER
WorkingDirectory=$DEPLOY_PATH/current
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vshot-signaling

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable vshot-signaling

echo "Systemd service created and enabled"

# 7. Configure firewall (if ufw is installed)
echo "[7/7] Configuring firewall..."
if command -v ufw &> /dev/null; then
  ufw allow 22/tcp    # SSH
  ufw allow 3000/tcp  # Signaling server
  ufw allow 8080/tcp  # HTTP API
  ufw allow 3478/tcp  # TURN server (if on same machine)
  ufw allow 3478/udp
  ufw allow 49152:65535/tcp  # TURN port range
  ufw allow 49152:65535/udp
  echo "Firewall rules added"
else
  echo "ufw not found, skipping firewall configuration"
fi

# Allow deployment user to restart service without password
echo "$DEPLOY_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart vshot-signaling" >> /etc/sudoers.d/vshot
chmod 440 /etc/sudoers.d/vshot

echo ""
echo "=================================="
echo "Setup completed successfully!"
echo "=================================="
echo ""
echo "Next steps:"
echo "1. Add your SSH public key to /home/$DEPLOY_USER/.ssh/authorized_keys"
echo "2. Create .env file at $DEPLOY_PATH/.env"
echo "3. Configure GitHub Secrets in your repository"
echo "4. Push to main branch to trigger deployment"
echo ""
echo "Deployment path: $DEPLOY_PATH"
echo "Service name: vshot-signaling.service"
echo ""
echo "Useful commands:"
echo "  systemctl status vshot-signaling  # Check service status"
echo "  journalctl -u vshot-signaling -f  # View logs"
echo "  systemctl restart vshot-signaling # Restart service"
echo ""
