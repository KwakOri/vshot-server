# VShot v2 Server.

WebRTC Signaling Server + High-Resolution Image Merge API

## Features

- WebRTC Signaling (WebSocket)
- Room Management (Host/Guest)
- High-resolution image upload
- Server-side image merging with alpha channel support
- Real-time photo selection synchronization

## Tech Stack

- Node.js + TypeScript
- Express
- WebSocket (ws)
- Sharp (image processing)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` file:

```bash
cp .env.example .env
```

3. Run in development:

```bash
npm run dev
```

4. Build for production:

```bash
npm run build
npm start
```

## API Endpoints

### HTTP REST API

- `GET /` - Server info
- `GET /health` - Health check
- `GET /api/internal/status` - Internal status snapshot (`X-Internal-Status-Key` required)
- `POST /api/photo/upload` - Upload photo (base64)
- `POST /api/photo/merge` - Merge host + guest photos
- `GET /api/photo/room/:roomId` - Get room photos

### WebSocket Signaling

Connect to `ws://localhost:3001/signaling`

**Message Types:**

```typescript
// Join room
{ type: 'join', roomId: string, userId: string, role: 'host' | 'guest' }

// WebRTC signaling
{ type: 'offer', roomId: string, from: string, to: string, sdp: string }
{ type: 'answer', roomId: string, from: string, to: string, sdp: string }
{ type: 'ice', roomId: string, from: string, to: string, candidate: RTCIceCandidateInit }

// Photo capture
{ type: 'capture-request', roomId: string, photoNumber: number }
{ type: 'capture-uploaded', roomId: string, userId: string, url: string, photoNumber: number }

// Photo selection
{ type: 'photo-select', roomId: string, userId: string, selectedIndices: number[] }
```

## Project Structure

```
src/
├── index.ts                 # Main server entry
├── types/
│   └── signal.ts           # TypeScript type definitions
├── services/
│   ├── SignalingServer.ts  # WebSocket signaling
│   ├── RoomManager.ts      # Room state management
│   └── ImageMerger.ts      # Image processing
└── routes/
    └── photo.ts            # Photo API routes
```

## Image Merge Flow

1. Host captures VR screen with transparent background → uploads PNG
2. Guest captures camera feed → uploads PNG
3. Server merges: Guest image as background + Host image (with alpha) as foreground
4. Returns merged image URL

## Environment Variables

```
PORT=3001
CORS_ORIGIN=http://localhost:3000
STORAGE_PATH=./uploads
```

## Deployment

### 🚀 Recommended: Docker + GitHub Actions

현재 권장 배포 경로는 Docker Compose와 GitHub Actions입니다.

- [Docker/Vultr 배포 가이드](./DOCKER-DEPLOYMENT.md)
- `scripts/setup-docker-server.sh`로 Vultr Docker 환경 준비
- `main` push 시 `.github/workflows/deploy.yml`이 GHCR image를 빌드하고 배포

기존 Node/systemd 방식은 레거시 운영 경로로 남겨 두었으며, 신규 배포에는 사용하지 않습니다.

### Legacy: Node/systemd deploy

자동 배포 설정:

```bash
# 1. Vultr 서버에서 초기 설정
sudo bash scripts/setup-server.sh

# 2. GitHub Secrets 설정 (4개)
# - SSH_PRIVATE_KEY
# - SSH_HOST
# - SSH_USER
# - DEPLOY_PATH

# 3. main 브랜치에 푸시하면 자동 배포
git push origin main
```

📖 **자세한 가이드:**

- [빠른 시작 (5분)](./QUICKSTART.md)
- [상세 배포 가이드](./DEPLOYMENT.md)

### GitHub Actions

기존 문서의 systemd/PM2 배포 방식 대신 현재 workflow는 Docker image 배포를 사용합니다:

- **트리거**: `main` 브랜치 push
- **프로세스**: Docker build → GHCR push → Vultr pull → Compose 재시작
- **서비스 관리**: Docker Compose

## Production Checklist

배포 전 확인사항:

- [ ] `/opt/vshot/.env.production` 설정 완료
- [ ] `CORS_ORIGIN` 프로덕션 도메인으로 설정
- [ ] `API_KEY`, `JWT_SECRET`, Supabase/R2 secret 설정
- [ ] Docker Compose healthcheck 통과
- [ ] reverse proxy가 `127.0.0.1:3000`과 WebSocket upgrade를 전달
- [ ] TURN 서버 설정 (옵션)
- [ ] SSL/TLS 인증서 설정 (권장)
- [ ] 로그 모니터링 설정
- [ ] 백업 전략 수립

## License

ISC
