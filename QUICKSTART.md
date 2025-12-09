# 🚀 VShot v2 서버 배포 빠른 시작 가이드

GitHub Actions를 통한 Vultr 자동 배포 설정을 5분 안에 완료하는 가이드입니다.

## ✅ 사전 준비

- [ ] Vultr 서버 (Ubuntu 22.04+)
- [ ] 서버 루트 또는 sudo 권한
- [ ] GitHub 저장소 관리자 권한

---

## 📝 단계별 설정

### 1️⃣ Vultr 서버 접속 및 초기 설정 (3분)

```bash
# 서버 접속
ssh root@YOUR_SERVER_IP

# 설정 스크립트 실행 (복사 & 붙여넣기)
curl -sSL https://raw.githubusercontent.com/YOUR_USERNAME/vshot-v2/main/server/scripts/setup-server.sh | sudo bash
```

또는 수동 실행:

```bash
# 프로젝트 클론
git clone https://github.com/YOUR_USERNAME/vshot-v2.git
cd vshot-v2/server

# 스크립트 실행
sudo bash scripts/setup-server.sh
```

스크립트가 완료되면 다음 정보를 메모하세요:
- 배포 경로: `/opt/vshot` (기본값)
- 배포 사용자: `vshot` (기본값)

### 2️⃣ SSH 키 생성 및 설정 (1분)

**로컬 머신에서:**

```bash
# SSH 키 생성
ssh-keygen -t ed25519 -C "github-deploy" -f ~/.ssh/vshot_deploy

# 공개키 출력 (복사)
cat ~/.ssh/vshot_deploy.pub
```

**Vultr 서버에서:**

```bash
# vshot 사용자로 전환
sudo su - vshot

# 공개키 등록 (위에서 복사한 내용 붙여넣기)
echo "YOUR_PUBLIC_KEY_HERE" >> ~/.ssh/authorized_keys

# 로그아웃
exit
```

**연결 테스트:**

```bash
ssh -i ~/.ssh/vshot_deploy vshot@YOUR_SERVER_IP
```

### 3️⃣ GitHub Secrets 설정 (1분)

GitHub 저장소 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

다음 4개의 Secret을 추가:

| Name | Value |
|------|-------|
| `SSH_PRIVATE_KEY` | `cat ~/.ssh/vshot_deploy` 전체 내용 |
| `SSH_HOST` | `YOUR_SERVER_IP` |
| `SSH_USER` | `vshot` |
| `DEPLOY_PATH` | `/opt/vshot` |

**헬스체크 URL (선택사항):**

| Name | Value |
|------|-------|
| `HEALTH_CHECK_URL` | `http://YOUR_SERVER_IP:3000/health` |

### 4️⃣ 환경 변수 설정 (30초)

**Vultr 서버에서:**

```bash
# 배포 경로로 이동
cd /opt/vshot

# .env 파일 생성
sudo nano .env
```

**최소 설정:**

```env
PORT=3000
NODE_ENV=production
CORS_ORIGIN=https://your-frontend-domain.vercel.app
API_KEY=your-secure-api-key-here
STORAGE_PATH=/opt/vshot/uploads
```

저장: `Ctrl + X` → `Y` → `Enter`

### 5️⃣ 배포 테스트 (30초)

**로컬에서:**

```bash
# 변경사항 커밋 & 푸시
git add .
git commit -m "Setup: configure deployment"
git push origin main
```

**GitHub에서 확인:**

GitHub → **Actions** → 최신 워크플로우 확인

**서버에서 확인:**

```bash
# 서비스 상태
systemctl status vshot-signaling

# 로그 확인
journalctl -u vshot-signaling -f
```

---

## 🎉 완료!

이제 `main` 브랜치에 푸시할 때마다 자동으로 배포됩니다.

### 배포 확인

```bash
# 헬스체크
curl http://YOUR_SERVER_IP:3000/health

# 서비스 정보
curl http://YOUR_SERVER_IP:3000/
```

---

## 🔧 자주 사용하는 명령어

### 서버 관리

```bash
# 서비스 상태 확인
systemctl status vshot-signaling

# 서비스 재시작
sudo systemctl restart vshot-signaling

# 로그 실시간 확인
journalctl -u vshot-signaling -f

# 최근 로그 50줄
journalctl -u vshot-signaling -n 50
```

### 배포 정보

```bash
# 현재 배포된 버전
cd /opt/vshot/current
cat package.json

# 백업 목록
ls -la /opt/vshot/backup_*

# 디스크 사용량
du -sh /opt/vshot/*
```

---

## 🐛 문제 해결

### 배포 실패

**GitHub Actions 로그 확인:**

GitHub → Actions → 실패한 워크플로우 → 로그 확인

**서버 로그 확인:**

```bash
journalctl -u vshot-signaling -n 100 --no-pager
```

### SSH 연결 실패

```bash
# 서버에서 권한 확인
sudo chmod 700 /home/vshot/.ssh
sudo chmod 600 /home/vshot/.ssh/authorized_keys
sudo chown -R vshot:vshot /home/vshot/.ssh

# 로컬에서 테스트
ssh -i ~/.ssh/vshot_deploy -v vshot@YOUR_SERVER_IP
```

### 서비스 시작 실패

```bash
# .env 파일 확인
cat /opt/vshot/.env

# 수동 실행 테스트
cd /opt/vshot/current
node dist/index.js
```

### 포트 접근 불가

```bash
# 방화벽 확인
sudo ufw status

# 포트 개방
sudo ufw allow 3000/tcp

# 포트 리스닝 확인
sudo netstat -tulpn | grep 3000
```

---

## 📚 추가 문서

- [상세 배포 가이드](./DEPLOYMENT.md)
- [서버 README](./README.md)
- [트러블슈팅](./DEPLOYMENT.md#5-트러블슈팅)

---

## 💡 팁

### 빠른 롤백

```bash
cd /opt/vshot
sudo rm -rf current
sudo cp -r backup_YYYYMMDD_HHMMSS current
sudo systemctl restart vshot-signaling
```

### 수동 배포

GitHub → Actions → Deploy to Vultr → Run workflow

### 환경 변수 업데이트

```bash
# .env 수정
sudo nano /opt/vshot/.env

# 서비스 재시작
sudo systemctl restart vshot-signaling
```

---

## 🔐 보안 체크리스트

- [ ] SSH 키 기반 인증 사용
- [ ] 강력한 API_KEY 설정
- [ ] CORS_ORIGIN 프로덕션 도메인으로 설정
- [ ] 방화벽 활성화 및 필요한 포트만 개방
- [ ] 정기적인 시스템 업데이트
- [ ] 서버 백업 설정

---

**질문이나 문제가 있으신가요?**

[이슈 트래커](https://github.com/YOUR_USERNAME/vshot-v2/issues)에 문의해주세요.
