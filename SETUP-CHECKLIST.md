# 🚀 VShot v2 서버 자동 배포 설정 체크리스트

## ✅ Step 1: 로컬에서 GitHub에 Push

```bash
cd /Users/kwakori/projects/promotion/vshot-v2/server

# 상태 확인
git status

# 추가된 파일들:
# - .github/workflows/deploy.yml
# - scripts/setup-server.sh
# - ecosystem.config.js
# - DEPLOYMENT.md
# - QUICKSTART.md
# - SETUP-CHECKLIST.md

# 모두 추가
git add .

# 커밋
git commit -m "Setup: GitHub Actions auto-deployment pipeline"

# Push
git push origin main
```

---

## ✅ Step 2: SSH 키 생성 (로컬)

```bash
# SSH 키 생성
ssh-keygen -t ed25519 -C "vshot-deploy" -f ~/.ssh/vshot_deploy

# 개인키 확인 (나중에 GitHub Secrets에 사용)
cat ~/.ssh/vshot_deploy

# 공개키 확인 (나중에 서버에 등록)
cat ~/.ssh/vshot_deploy.pub
```

**메모해두기:**
- [ ] 개인키 내용 복사 완료
- [ ] 공개키 내용 복사 완료

---

## ✅ Step 3: Vultr 서버 초기 설정

### 방법 1: 스크립트 직접 전송

```bash
# 로컬에서
scp server/scripts/setup-server.sh root@YOUR_SERVER_IP:/tmp/

# 서버에서
ssh root@YOUR_SERVER_IP
sudo bash /tmp/setup-server.sh
```

### 방법 2: GitHub에서 다운로드

```bash
# 서버에서
ssh root@YOUR_SERVER_IP

# Step 1에서 push한 후에만 가능
curl -sSL https://raw.githubusercontent.com/YOUR_USERNAME/vshot-v2/main/server/scripts/setup-server.sh -o setup.sh

sudo bash setup.sh
```

**스크립트 실행 후 메모:**
- [ ] 배포 경로 확인: `/opt/vshot`
- [ ] 배포 사용자 확인: `vshot`

---

## ✅ Step 4: 서버에 SSH 공개키 등록

```bash
# Vultr 서버에서
sudo su - vshot

# 공개키 등록 (Step 2에서 복사한 공개키 붙여넣기)
echo "ssh-ed25519 AAAA... vshot-deploy" >> ~/.ssh/authorized_keys

# 권한 확인
chmod 600 ~/.ssh/authorized_keys

# 로그아웃
exit
exit
```

**테스트:**
```bash
# 로컬에서
ssh -i ~/.ssh/vshot_deploy vshot@YOUR_SERVER_IP

# 연결되면 성공!
exit
```

- [ ] SSH 키 연결 테스트 완료

---

## ✅ Step 5: 환경 변수 설정

```bash
# Vultr 서버에서
ssh root@YOUR_SERVER_IP
cd /opt/vshot
nano .env
```

**최소 설정:**
```env
PORT=3000
NODE_ENV=production
CORS_ORIGIN=https://your-frontend.vercel.app
API_KEY=your-super-secret-api-key-here
STORAGE_PATH=/opt/vshot/uploads
```

**선택 설정 (TURN 서버):**
```env
TURN_SERVER_URL=turn:your-turn-server.com:3478
TURN_USERNAME=username
TURN_CREDENTIAL=password
```

저장: `Ctrl + X` → `Y` → `Enter`

- [ ] .env 파일 생성 완료
- [ ] CORS_ORIGIN 프로덕션 도메인으로 설정
- [ ] API_KEY 강력한 값으로 설정

---

## ✅ Step 6: GitHub Secrets 설정

**GitHub 저장소 → Settings → Secrets and variables → Actions**

### 필수 Secrets (4개)

**1. SSH_PRIVATE_KEY**
```bash
# 로컬에서 전체 내용 복사
cat ~/.ssh/vshot_deploy
```
- Name: `SSH_PRIVATE_KEY`
- Secret: 복사한 내용 전체 붙여넣기

**2. SSH_HOST**
- Name: `SSH_HOST`
- Secret: `YOUR_SERVER_IP` (예: `123.45.67.89`)

**3. SSH_USER**
- Name: `SSH_USER`
- Secret: `vshot`

**4. DEPLOY_PATH**
- Name: `DEPLOY_PATH`
- Secret: `/opt/vshot`

### 선택 Secret

**5. HEALTH_CHECK_URL** (권장)
- Name: `HEALTH_CHECK_URL`
- Secret: `http://YOUR_SERVER_IP:3000/health`

**체크리스트:**
- [ ] SSH_PRIVATE_KEY 설정 완료
- [ ] SSH_HOST 설정 완료
- [ ] SSH_USER 설정 완료
- [ ] DEPLOY_PATH 설정 완료
- [ ] HEALTH_CHECK_URL 설정 완료 (선택)

---

## ✅ Step 7: 배포 테스트

```bash
# 로컬에서
cd /Users/kwakori/projects/promotion/vshot-v2/server

# 테스트 변경
echo "# Test deployment" >> README.md

# 커밋 & Push
git add .
git commit -m "Test: initial deployment"
git push origin main
```

**GitHub에서 확인:**
1. GitHub 저장소로 이동
2. **Actions** 탭 클릭
3. 최신 워크플로우 확인 (Deploy to Vultr)
4. 진행 상황 확인

**성공 확인:**
```bash
# 서버에서
ssh vshot@YOUR_SERVER_IP

# 서비스 상태
systemctl status vshot-signaling

# 로그 확인
journalctl -u vshot-signaling -n 20

# 헬스체크
curl http://localhost:3000/health
```

**외부에서 확인:**
```bash
# 로컬에서
curl http://YOUR_SERVER_IP:3000/health
```

- [ ] GitHub Actions 워크플로우 성공
- [ ] 서비스 정상 작동 확인
- [ ] 헬스체크 응답 확인

---

## ✅ Step 8: 방화벽 설정 (필요시)

Vultr 대시보드 또는 서버에서:

```bash
# 서버에서
sudo ufw status

# 필요한 포트 개방
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 3000/tcp  # Signaling Server
```

**Vultr 대시보드:**
- Settings → Firewall → Add Firewall Rule
- Port 3000 TCP 허용

- [ ] 방화벽 포트 개방 완료

---

## 🎉 완료!

모든 단계가 완료되었습니다. 이제부터는:

```bash
# 로컬에서 코드 수정 후
git add .
git commit -m "Your message"
git push origin main

# 자동으로 배포됨!
```

---

## 🔧 유용한 명령어

### 서버 관리
```bash
# 서비스 상태
systemctl status vshot-signaling

# 로그 실시간 확인
journalctl -u vshot-signaling -f

# 서비스 재시작
sudo systemctl restart vshot-signaling
```

### 배포 확인
```bash
# 현재 버전
cd /opt/vshot/current
cat package.json

# 백업 목록
ls -la /opt/vshot/
```

### 롤백
```bash
cd /opt/vshot
sudo rm -rf current
sudo cp -r backup_YYYYMMDD_HHMMSS current
sudo systemctl restart vshot-signaling
```

---

## 🐛 문제 발생 시

1. **GitHub Actions 로그 확인**
   - GitHub → Actions → 실패한 워크플로우

2. **서버 로그 확인**
   ```bash
   journalctl -u vshot-signaling -n 100
   ```

3. **수동 실행 테스트**
   ```bash
   cd /opt/vshot/current
   node dist/index.js
   ```

4. [DEPLOYMENT.md 트러블슈팅](./DEPLOYMENT.md#5-트러블슈팅) 참고

---

## 📞 도움말

- [빠른 시작 가이드](./QUICKSTART.md)
- [상세 배포 가이드](./DEPLOYMENT.md)
- [이슈 트래커](https://github.com/YOUR_USERNAME/vshot-v2/issues)
