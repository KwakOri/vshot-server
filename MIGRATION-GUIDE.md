# 🔄 기존 서버를 자동 배포로 마이그레이션

기존에 Vultr 서버에서 수동으로 배포하던 환경을 GitHub Actions 자동 배포로 전환하는 가이드입니다.

## 📋 현재 상황 파악

먼저 Vultr 서버에 접속해서 현재 상태를 확인하세요.

```bash
ssh root@YOUR_SERVER_IP  # 또는 기존 사용자로 접속

# 1. 현재 서버 코드 위치 확인
pwd
ls -la

# 2. 실행 방법 확인
# systemd를 사용 중인지?
systemctl status vshot-signaling 2>/dev/null || echo "systemd service not found"

# PM2를 사용 중인지?
pm2 list 2>/dev/null || echo "PM2 not found"

# 수동 실행 중인지?
ps aux | grep node

# 3. Node.js 버전 확인
node --version
npm --version

# 4. 현재 디렉토리 구조
ls -la
```

---

## 🎯 마이그레이션 시나리오

### 시나리오 A: 수동 배포 중 (추천)

현재 `/root/vshot-v2/server` 또는 홈 디렉토리에서 수동으로 관리 중

**→ 새로운 배포 디렉토리로 이동하고 자동화 설정**

### 시나리오 B: 이미 systemd 사용 중

이미 서비스로 실행 중

**→ 배포 자동화만 추가**

### 시나리오 C: PM2 사용 중

PM2로 프로세스 관리 중

**→ PM2 설정 유지하면서 배포 자동화 추가**

---

## ✅ 시나리오 A: 수동 배포 → 자동 배포 (추천)

### 1. 배포용 사용자 생성 (옵션)

```bash
# root로 접속한 상태에서
sudo useradd -m -s /bin/bash vshot
```

### 2. 배포 디렉토리 생성

```bash
# 새로운 배포 디렉토리
sudo mkdir -p /opt/vshot
sudo chown -R vshot:vshot /opt/vshot

# 또는 기존 디렉토리 사용 (예: /home/ubuntu/vshot)
# 이 경우 DEPLOY_PATH를 해당 경로로 설정
```

### 3. 환경 변수 복사

```bash
# 기존 .env 파일 복사
sudo cp /path/to/your/old/.env /opt/vshot/.env
sudo chown vshot:vshot /opt/vshot/.env
```

### 4. systemd 서비스 생성

```bash
sudo nano /etc/systemd/system/vshot-signaling.service
```

다음 내용 입력:

```ini
[Unit]
Description=VShot v2 Signaling Server
After=network.target

[Service]
Type=simple
User=vshot
WorkingDirectory=/opt/vshot/current
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vshot-signaling

[Install]
WantedBy=multi-user.target
```

```bash
# 서비스 활성화
sudo systemctl daemon-reload
sudo systemctl enable vshot-signaling
```

### 5. sudo 권한 설정 (서비스 재시작용)

```bash
echo "vshot ALL=(ALL) NOPASSWD: /bin/systemctl restart vshot-signaling" | sudo tee /etc/sudoers.d/vshot
sudo chmod 440 /etc/sudoers.d/vshot
```

### 6. SSH 키 설정

```bash
# vshot 사용자로 전환
sudo su - vshot

# .ssh 디렉토리 생성
mkdir -p ~/.ssh
chmod 700 ~/.ssh

# authorized_keys 생성 (로컬에서 생성한 공개키 추가)
nano ~/.ssh/authorized_keys
# 공개키 붙여넣기

chmod 600 ~/.ssh/authorized_keys
exit
```

### 7. 기존 서버 중지

```bash
# PM2 사용 중이었다면
pm2 stop all
pm2 delete all

# 수동 실행 중이었다면
# Ctrl+C 또는
pkill -f "node.*index.js"
```

### 8. 첫 배포 대기

이제 GitHub에서 push하면 자동으로 배포됩니다!

---

## ✅ 시나리오 B: 이미 systemd 사용 중

### 1. 현재 서비스 확인

```bash
systemctl status vshot-signaling
systemctl cat vshot-signaling
```

### 2. 배포 디렉토리 확인 및 조정

```bash
# 현재 WorkingDirectory 확인
systemctl cat vshot-signaling | grep WorkingDirectory

# 배포 구조로 변경
# 기존: /home/user/server
# 변경: /home/user/server/current (심볼릭 링크 방식)
```

### 3. 배포 구조 설정

```bash
# 기존 디렉토리를 배포 경로로 사용
CURRENT_DIR="/home/user/server"  # 현재 경로
DEPLOY_DIR=$(dirname "$CURRENT_DIR")

# 현재 디렉토리를 current로 변경
cd "$DEPLOY_DIR"
sudo mv server current

# 또는 심볼릭 링크 생성
# sudo ln -s /path/to/actual server/current
```

### 4. systemd 서비스 파일 수정

```bash
sudo nano /etc/systemd/system/vshot-signaling.service
```

`WorkingDirectory`를 `/opt/vshot/current` 또는 배포 경로로 수정:

```ini
WorkingDirectory=/opt/vshot/current
# 또는
WorkingDirectory=/home/user/vshot/current
```

```bash
sudo systemctl daemon-reload
```

### 5. SSH 및 sudo 권한 설정

위의 시나리오 A의 5-6번 단계 참고

---

## ✅ 시나리오 C: PM2 사용 중

### 1. 배포 자동화 + PM2 유지

GitHub Actions 워크플로우의 재시작 부분만 수정하면 됩니다.

서버에서:

```bash
# ecosystem.config.js가 있는지 확인
ls ecosystem.config.js

# 없다면 생성
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'vshot-signaling',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
EOF
```

### 2. PM2 시작 스크립트

```bash
# PM2로 서비스 시작
pm2 start ecosystem.config.js

# 부팅 시 자동 시작 설정
pm2 startup
pm2 save
```

### 3. GitHub Actions는 기본 설정 그대로 사용

워크플로우가 자동으로 PM2를 감지하고 재시작합니다.

---

## 🔑 공통: SSH 키 설정

모든 시나리오에서 필요합니다.

### 로컬에서

```bash
# SSH 키 생성
ssh-keygen -t ed25519 -C "github-deploy" -f ~/.ssh/vshot_deploy

# 공개키 출력
cat ~/.ssh/vshot_deploy.pub
```

### 서버에서

```bash
# 배포 사용자로 전환 (vshot 또는 기존 사용자)
sudo su - vshot  # 또는 sudo su - ubuntu

# 공개키 추가
mkdir -p ~/.ssh
chmod 700 ~/.ssh
echo "ssh-ed25519 AAAA... github-deploy" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
exit
```

### 테스트

```bash
# 로컬에서
ssh -i ~/.ssh/vshot_deploy vshot@YOUR_SERVER_IP
```

---

## 📝 GitHub Secrets 설정

시나리오에 따라 경로가 다를 수 있습니다:

| Secret | 시나리오 A | 시나리오 B | 시나리오 C |
|--------|-----------|-----------|-----------|
| `SSH_USER` | `vshot` | 기존 사용자 | 기존 사용자 |
| `DEPLOY_PATH` | `/opt/vshot` | `/home/user/vshot` | `/home/user/vshot` |

나머지는 동일:
- `SSH_PRIVATE_KEY`: 개인키 전체 내용
- `SSH_HOST`: 서버 IP

---

## 🧪 첫 배포 테스트

### 1. 기존 서비스 중지

```bash
# systemd
sudo systemctl stop vshot-signaling

# PM2
pm2 stop vshot-signaling
```

### 2. GitHub에서 배포

```bash
# 로컬에서
cd /Users/kwakori/projects/promotion/vshot-v2/server
git add .
git commit -m "Deploy: migrate to auto-deployment"
git push origin main
```

### 3. 배포 확인

GitHub → Actions → 워크플로우 진행 상황 확인

### 4. 서비스 확인

```bash
# 서버에서
systemctl status vshot-signaling
# 또는
pm2 list

# 로그 확인
journalctl -u vshot-signaling -f
# 또는
pm2 logs vshot-signaling

# 헬스체크
curl http://localhost:3000/health
```

---

## 🎯 최소 변경 옵션 (기존 환경 그대로)

기존 디렉토리와 사용자를 그대로 사용하고 싶다면:

### 1. SSH 키만 추가

```bash
# 현재 사용자의 authorized_keys에 추가
echo "공개키" >> ~/.ssh/authorized_keys
```

### 2. GitHub Secrets를 기존 환경에 맞게 설정

```
SSH_USER=현재_사용자_이름
DEPLOY_PATH=현재_서버_디렉토리_경로
```

### 3. 배포 디렉토리 구조만 변경

```bash
# 현재 위치: /home/ubuntu/vshot-v2/server
cd /home/ubuntu/vshot-v2

# 디렉토리 복사
cp -r server current

# .env 복사
cp current/.env ./.env
```

이렇게 하면 `/home/ubuntu/vshot-v2/current`에 배포되고, GitHub Actions의 `DEPLOY_PATH`를 `/home/ubuntu/vshot-v2`로 설정하면 됩니다.

---

## ✅ 체크리스트

- [ ] 현재 서버 상태 파악 완료
- [ ] 배포 디렉토리 구조 설정
- [ ] SSH 키 설정 및 테스트
- [ ] systemd/PM2 서비스 설정
- [ ] GitHub Secrets 설정
- [ ] .env 파일 복사/생성
- [ ] sudo 권한 설정 (필요시)
- [ ] 첫 배포 테스트 성공
- [ ] 서비스 정상 작동 확인

---

## 🔄 롤백 방법

문제가 생기면 기존 방식으로 되돌릴 수 있습니다:

```bash
# 배포 중지
# GitHub Actions 비활성화: 워크플로우 파일 삭제 또는 비활성화

# 기존 디렉토리로 복귀
cd /path/to/old/directory

# 기존 방식으로 실행
npm run build
npm start
# 또는
pm2 start ecosystem.config.js
```

---

## 💡 권장 사항

1. **점진적 마이그레이션**: 먼저 테스트 환경에서 시도
2. **백업**: 기존 서버 코드와 .env 백업
3. **다운타임 최소화**: 배포 시간대 선택
4. **모니터링**: 첫 배포 후 로그 집중 모니터링

---

궁금한 점이 있으면 [DEPLOYMENT.md](./DEPLOYMENT.md)를 참고하세요!
