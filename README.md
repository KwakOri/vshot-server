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

## License

ISC
