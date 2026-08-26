# VShot Docker 배포 가이드

현재 권장 배포 방식은 PM2/systemd가 아니라 Docker Compose + GitHub Actions입니다.

```text
Vercel (vshot.site)
        │ HTTPS / WSS
        ▼
Vultr reverse proxy (stream.vshot.site)
        │ http://127.0.0.1:3000
        ▼
Docker Compose: vshot-server
```

## 1. DNS와 TLS

다음 레코드를 실제 서비스 제공자에 등록합니다.

| 호스트 | 대상 |
| --- | --- |
| `vshot.site` | Vercel 프로젝트 도메인 |
| `stream.vshot.site` | Vultr 공인 IPv4 |
| `storage.vshot.site` | Cloudflare R2 public/custom domain |

`stream.vshot.site`는 반드시 HTTPS를 사용해야 하며, reverse proxy가 WebSocket 업그레이드를 전달해야 합니다.

Nginx를 사용하는 경우 핵심 설정은 다음과 같습니다.

```nginx
server {
    listen 443 ssl http2;
    server_name stream.vshot.site;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 2. Vultr Docker 준비

Ubuntu 22.04+ 서버에서 저장소의 setup script를 실행합니다.

```bash
sudo DEPLOY_USER=vshot DEPLOY_PATH=/opt/vshot \
  bash scripts/setup-docker-server.sh
```

스크립트는 Docker, Docker Compose plugin, 배포 디렉터리와 `vshot` 사용자의 Docker 권한을 준비합니다. 그룹 권한 반영을 위해 SSH를 다시 연결해야 할 수 있습니다.

Compose 파일을 배포 경로에 둡니다.

```bash
sudo install -o vshot -g vshot -m 0644 \
  docker-compose.production.yml /opt/vshot/docker-compose.production.yml
```

## 3. Vultr 환경변수

템플릿을 복사한 뒤 실제 secret을 입력합니다.

```bash
sudo install -o vshot -g vshot -m 0600 \
  .env.production.example /opt/vshot/.env.production
sudoedit /opt/vshot/.env.production
```

`API_KEY`, `INTERNAL_STATUS_API_KEY`, `JWT_SECRET`, Supabase service-role key, R2 access key/secret은 실제 값으로 교체해야 합니다. `.env.production`은 Git에 커밋하지 않습니다.

TURN을 아직 준비하지 않은 경우 세 개의 `TURN_*` 값을 비워 둡니다. Coturn과 TLS 5349를 준비한 뒤 `turns:` URL을 입력하고 컨테이너를 재시작합니다.

## 4. GitHub Secrets

`server` 저장소에 다음 Actions secrets를 등록합니다.

| Secret | 용도 |
| --- | --- |
| `SSH_PRIVATE_KEY` | Vultr 접속용 private key |
| `SSH_HOST` | Vultr IP 또는 hostname |
| `SSH_USER` | Docker 권한이 있는 배포 사용자, 예: `vshot` |
| `DEPLOY_PATH` | 예: `/opt/vshot` |
| `GHCR_USERNAME` | GHCR read 권한 사용자 |
| `GHCR_READ_TOKEN` | `read:packages` 권한의 GitHub PAT |
| `HEALTH_CHECK_URL` | 선택: `https://stream.vshot.site/health` |

GitHub Actions의 `GITHUB_TOKEN`은 이미지를 GHCR에 push하고, Vultr에서는 `GHCR_READ_TOKEN`으로 이미지를 pull합니다.

## 5. 배포 흐름

`main` 브랜치에 push하면 [deploy.yml](./.github/workflows/deploy.yml)이 다음을 수행합니다.

1. Docker image build
2. GHCR push (`commit SHA`와 `latest`)
3. Vultr Docker client의 GHCR 로그인
4. Compose 파일 업로드
5. `docker compose pull` 및 `up -d`
6. 선택된 public health check

수동 실행은 GitHub Actions의 **Run workflow**를 사용합니다.

## 6. 서버 확인과 롤백

```bash
cd /opt/vshot
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs --tail=100 vshot-server
curl -fsS http://127.0.0.1:3000/health
```

롤백은 이전 commit SHA image를 지정해 실행합니다.

```bash
VSHOT_SERVER_IMAGE=ghcr.io/OWNER/REPOSITORY:PREVIOUS_SHA \
  docker compose -f docker-compose.production.yml up -d
```

## 7. 배포 전 체크리스트

- [ ] DNS 세 호스트가 해석됨
- [ ] `stream.vshot.site` HTTPS 인증서 발급
- [ ] reverse proxy의 WebSocket 업그레이드 확인
- [ ] `/opt/vshot/.env.production` 실제 secret 입력
- [ ] GHCR read token 등록
- [ ] Supabase/R2 연결 확인
- [ ] `curl https://stream.vshot.site/health` 성공
- [ ] Vercel production environment variables 입력
