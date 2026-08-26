# VShot v2 서버 자동 배포 가이드

> 신규 배포는 [DOCKER-DEPLOYMENT.md](./DOCKER-DEPLOYMENT.md)를 사용하세요. 이 문서는 기존 Node/systemd/PM2 방식의 레거시 참고 문서입니다.

GitHub Actions를 통한 Vultr 서버 자동 배포 설정 가이드입니다.

## 📋 목차

1. [Vultr 서버 초기 설정](#1-vultr-서버-초기-설정)
2. [SSH 키 생성 및 설정](#2-ssh-키-생성-및-설정)
3. [GitHub Secrets 설정](#3-github-secrets-설정)
4. [배포 프로세스](#4-배포-프로세스)
5. [트러블슈팅](#5-트러블슈팅)

---

## 1. Vultr 서버 초기 설정

### 1.1 서버 접속

```bash
ssh root@your-vultr-server-ip
```

### 1.2 초기 설정 스크립트 실행

```bash
# 스크립트 다운로드 (또는 직접 복사)
curl -O https://raw.githubusercontent.com/your-repo/vshot-v2/main/server/scripts/setup-server.sh

# 실행 권한 부여
chmod +x setup-server.sh

# 실행 (기본값 사용)
sudo ./setup-server.sh

# 또는 커스텀 설정으로 실행
sudo DEPLOY_USER=myuser DEPLOY_PATH=/home/myuser/app ./setup-server.sh
```

스크립트는 다음을 수행합니다:
- Node.js 20 설치
- 배포용 사용자 생성 (기본: `vshot`)
- 배포 디렉토리 생성 (기본: `/opt/vshot`)
- systemd 서비스 설정
- 방화벽 규칙 추가

### 1.3 환경 변수 파일 생성

```bash
# 배포 경로로 이동
cd /opt/vshot

# .env 파일 생성
sudo nano .env
```

`.env` 파일 내용:
```bash
PORT=3000
NODE_ENV=production
CORS_ORIGIN=https://your-frontend-domain.com

# 업로드 설정
UPLOAD_DIR=/opt/vshot/uploads
MAX_FILE_SIZE=10485760

# TURN 서버 설정 (옵션)
TURN_SERVER=turn:your-turn-server.com:3478
TURN_USERNAME=username
TURN_PASSWORD=password
```

---

## 2. SSH 키 생성 및 설정

### 2.1 SSH 키 쌍 생성 (로컬 머신에서)

```bash
# 배포용 SSH 키 생성
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/vshot_deploy

# 개인키 내용 확인 (GitHub Secrets에 사용)
cat ~/.ssh/vshot_deploy

# 공개키 내용 확인 (서버에 등록)
cat ~/.ssh/vshot_deploy.pub
```

### 2.2 서버에 공개키 등록

Vultr 서버에서:

```bash
# vshot 사용자로 전환
sudo su - vshot

# authorized_keys에 공개키 추가
echo "ssh-ed25519 AAAA... github-actions-deploy" >> ~/.ssh/authorized_keys

# 권한 확인
chmod 600 ~/.ssh/authorized_keys
```

### 2.3 SSH 연결 테스트

로컬에서:

```bash
ssh -i ~/.ssh/vshot_deploy vshot@your-vultr-server-ip
```

---

## 3. GitHub Secrets 설정

GitHub 저장소 → Settings → Secrets and variables → Actions → New repository secret

### 필수 Secrets

| Secret 이름 | 설명 | 예시 값 |
|-------------|------|---------|
| `SSH_PRIVATE_KEY` | SSH 개인키 전체 내용 | `-----BEGIN OPENSSH PRIVATE KEY-----\n...` |
| `SSH_HOST` | Vultr 서버 IP 주소 | `123.45.67.89` |
| `SSH_USER` | 배포 사용자 이름 | `vshot` |
| `DEPLOY_PATH` | 서버 배포 경로 | `/opt/vshot` |

### 선택 Secrets

| Secret 이름 | 설명 | 예시 값 |
|-------------|------|---------|
| `HEALTH_CHECK_URL` | 배포 후 헬스체크 URL | `http://123.45.67.89:3000/health` |

### SSH_PRIVATE_KEY 설정 방법

1. 로컬에서 개인키 전체 내용 복사:
   ```bash
   cat ~/.ssh/vshot_deploy
   ```

2. GitHub Secrets에 추가:
   - Name: `SSH_PRIVATE_KEY`
   - Secret: 복사한 개인키 전체 내용 붙여넣기
   - `-----BEGIN OPENSSH PRIVATE KEY-----` 부터 `-----END OPENSSH PRIVATE KEY-----` 까지 모두 포함

---

## 4. 배포 프로세스

### 4.1 자동 배포 트리거

`main` 브랜치에 push하면 자동으로 배포됩니다:

```bash
git add .
git commit -m "Deploy: update signaling logic"
git push origin main
```

### 4.2 수동 배포 트리거

GitHub → Actions → Deploy to Vultr → Run workflow

### 4.3 배포 플로우

```
1. 코드 체크아웃
   ↓
2. Node.js 설정 및 의존성 설치
   ↓
3. TypeScript 빌드 (npm run build)
   ↓
4. 배포 패키지 생성 (dist + package.json)
   ↓
5. Vultr 서버로 전송 (SCP)
   ↓
6. 서버에서 배포 스크립트 실행
   - 현재 버전 백업
   - 새 버전 압축 해제
   - 프로덕션 의존성 설치
   - 서비스 재시작
   ↓
7. 헬스체크 (옵션)
```

### 4.4 배포 확인

```bash
# 서버에 접속
ssh vshot@your-vultr-server-ip

# 서비스 상태 확인
systemctl status vshot-signaling

# 로그 확인
journalctl -u vshot-signaling -f

# 현재 배포된 버전 확인
cd /opt/vshot/current
cat package.json
```

---

## 5. 트러블슈팅

### 5.1 SSH 연결 실패

**증상**: `Permission denied (publickey)`

**해결**:
```bash
# 서버에서 권한 확인
sudo chmod 700 /home/vshot/.ssh
sudo chmod 600 /home/vshot/.ssh/authorized_keys
sudo chown -R vshot:vshot /home/vshot/.ssh

# 로컬에서 SSH 키 테스트
ssh -i ~/.ssh/vshot_deploy -v vshot@your-vultr-server-ip
```

### 5.2 서비스 시작 실패

**증상**: `systemctl status vshot-signaling` → failed

**해결**:
```bash
# 로그 확인
journalctl -u vshot-signaling -n 50 --no-pager

# .env 파일 확인
cat /opt/vshot/.env

# 수동 실행 테스트
cd /opt/vshot/current
node dist/index.js
```

### 5.3 빌드 실패

**증상**: GitHub Actions에서 `npm run build` 실패

**해결**:
- TypeScript 오류 확인
- 로컬에서 빌드 테스트: `npm run build`
- `tsconfig.json` 설정 확인

### 5.4 포트 접근 불가

**증상**: 외부에서 서버 접근 안됨

**해결**:
```bash
# 방화벽 상태 확인
sudo ufw status

# 포트 개방
sudo ufw allow 3000/tcp

# Vultr 대시보드에서 방화벽 설정 확인
```

### 5.5 롤백 방법

```bash
# 서버에 접속
ssh vshot@your-vultr-server-ip

# 백업 목록 확인
ls -la /opt/vshot/

# 이전 버전으로 롤백
cd /opt/vshot
sudo rm -rf current
sudo cp -r backup_YYYYMMDD_HHMMSS current

# 서비스 재시작
sudo systemctl restart vshot-signaling
```

---

## 6. PM2 사용 (대안)

systemd 대신 PM2를 사용하려면:

### 6.1 PM2 설치

```bash
sudo npm install -g pm2
```

### 6.2 서비스 시작

```bash
cd /opt/vshot/current
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### 6.3 GitHub Actions 수정

`.github/workflows/deploy.yml`의 재시작 부분을:

```bash
pm2 restart vshot-signaling || pm2 start dist/index.js --name vshot-signaling
```

---

## 7. 모니터링

### 7.1 로그 확인

```bash
# systemd 사용 시
journalctl -u vshot-signaling -f

# PM2 사용 시
pm2 logs vshot-signaling
```

### 7.2 리소스 모니터링

```bash
# 서버 리소스
htop

# PM2 모니터링
pm2 monit
```

---

## 8. 보안 권장사항

1. **SSH 설정**
   - root 로그인 비활성화
   - 비밀번호 인증 비활성화
   - SSH 포트 변경 고려

2. **방화벽**
   - 필요한 포트만 개방
   - fail2ban 설치 권장

3. **업데이트**
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

4. **백업**
   - 정기적인 서버 스냅샷
   - 데이터베이스 백업 (해당 시)

---

## 📞 문제 발생 시

1. GitHub Actions 로그 확인
2. 서버 로그 확인: `journalctl -u vshot-signaling`
3. 이슈 트래커에 문의

---

## 🔗 관련 문서

- [서버 README](./README.md)
- [TURN 서버 설정](../TURN-SETUP.md)
- [CLAUDE.md](../claude.md)
