# VShot v2 Server

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

### 🚀 Quick Deploy to Vultr

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

이 저장소는 GitHub Actions를 통한 자동 배포를 지원합니다:

- **트리거**: `main` 브랜치 push
- **프로세스**: 빌드 → 전송 → 배포 → 재시작
- **서비스 관리**: systemd 또는 PM2

## Production Checklist

배포 전 확인사항:

- [ ] `.env` 파일 설정 완료
- [ ] `CORS_ORIGIN` 프로덕션 도메인으로 설정
- [ ] `API_KEY` 강력한 값으로 설정
- [ ] 방화벽 포트 개방 (3000/tcp)
- [ ] TURN 서버 설정 (옵션)
- [ ] SSL/TLS 인증서 설정 (권장)
- [ ] 로그 모니터링 설정
- [ ] 백업 전략 수립

## License

ISC
