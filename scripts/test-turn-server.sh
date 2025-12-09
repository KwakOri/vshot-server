#!/bin/bash

# TURN Server 테스트 스크립트

echo "=================================="
echo "TURN Server Test"
echo "=================================="

# 서버 IP 확인
EXTERNAL_IP=$(curl -s ifconfig.me)
echo ""
echo "Server IP: $EXTERNAL_IP"
echo ""

# 1. 서비스 상태 확인
echo "[1/5] Checking coturn service..."
if systemctl is-active --quiet coturn; then
  echo "✅ coturn service is running"
else
  echo "❌ coturn service is NOT running"
  echo "Start with: sudo systemctl start coturn"
  exit 1
fi

# 2. 포트 확인
echo ""
echo "[2/5] Checking listening ports..."
if sudo netstat -tulpn | grep -q ':3478'; then
  echo "✅ Port 3478 (TURN) is listening"
else
  echo "❌ Port 3478 is NOT listening"
fi

if sudo netstat -tulpn | grep -q ':5349'; then
  echo "✅ Port 5349 (TURNS) is listening"
else
  echo "⚠️  Port 5349 (TURNS) is NOT listening"
fi

# 3. 방화벽 확인
echo ""
echo "[3/5] Checking firewall..."
if command -v ufw &> /dev/null; then
  if sudo ufw status | grep -q '3478'; then
    echo "✅ Firewall allows TURN ports"
  else
    echo "⚠️  Firewall may be blocking TURN ports"
    echo "Run: sudo ufw allow 3478/tcp && sudo ufw allow 3478/udp"
  fi
else
  echo "⚠️  ufw not installed, cannot check firewall"
fi

# 4. 설정 파일 확인
echo ""
echo "[4/5] Checking configuration..."
if [ -f /etc/turnserver.conf ]; then
  echo "✅ Configuration file exists"

  # 크리덴셜 확인
  if grep -q "^user=" /etc/turnserver.conf; then
    echo "✅ User credentials configured"
    TURN_USER=$(grep "^user=" /etc/turnserver.conf | head -1 | cut -d= -f2 | cut -d: -f1)
    echo "   Username: $TURN_USER"
  else
    echo "⚠️  No user credentials found"
  fi

  # Realm 확인
  if grep -q "^realm=" /etc/turnserver.conf; then
    REALM=$(grep "^realm=" /etc/turnserver.conf | cut -d= -f2)
    echo "✅ Realm configured: $REALM"
  fi
else
  echo "❌ Configuration file not found"
fi

# 5. 연결 테스트
echo ""
echo "[5/5] Testing TURN connectivity..."

# stun 명령어가 있으면 테스트
if command -v stunclient &> /dev/null; then
  echo "Testing STUN..."
  stunclient $EXTERNAL_IP 3478
else
  echo "⚠️  stunclient not installed (optional)"
  echo "Install with: sudo apt-get install stuntman-client"
fi

# 로그 확인
echo ""
echo "Recent logs:"
if [ -f /var/log/turnserver.log ]; then
  tail -5 /var/log/turnserver.log
else
  journalctl -u coturn -n 5 --no-pager
fi

echo ""
echo "=================================="
echo "Test completed!"
echo "=================================="
echo ""
echo "To test from client (browser console):"
echo ""
cat << 'EOF'
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:YOUR_SERVER_IP:3478',
      username: 'YOUR_TURN_USER',
      credential: 'YOUR_TURN_PASSWORD'
    }
  ]
});

pc.createDataChannel('test');
pc.createOffer().then(offer => pc.setLocalDescription(offer));
pc.onicecandidate = e => {
  if (e.candidate) {
    console.log('ICE candidate:', e.candidate.candidate);
    if (e.candidate.candidate.includes('relay')) {
      console.log('✅ TURN is working!');
    }
  }
};
EOF

echo ""
echo "TURN Server URLs for your app:"
echo "  turn:$EXTERNAL_IP:3478"
echo "  turns:$EXTERNAL_IP:5349"
