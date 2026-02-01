import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { SignalingServer } from './services/SignalingServer';
import { RoomManager } from './services/RoomManager';
import { ImageMerger } from './services/ImageMerger';
import { createPhotoRouter } from './routes/photo';
import { createVideoRouter } from './routes/video';
import { createTestProcessRouter } from './routes/test-process';
import { createVideoV2Router } from './routes/video-v2';
import { apiKeyAuth } from './middleware/apiKeyAuth';

// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);

// Configuration
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, '../uploads');

// Middleware
app.use(cors({
  origin: CORS_ORIGIN,
  credentials: true
}));

// IMPORTANT: Route-specific body parsers MUST come BEFORE global body parser
// to avoid the global limit being applied first

// Increase limit for photo uploads (high-resolution images can be large when base64 encoded)
app.use('/api/photo/upload', express.json({ limit: '50mb' }));
app.use('/api/photo/upload', express.urlencoded({ extended: true, limit: '50mb' }));

// Increase limit for video uploads
app.use('/api/video/upload', express.json({ limit: '100mb' }));
app.use('/api/video/upload', express.urlencoded({ extended: true, limit: '100mb' }));

// Increase limit for video-v2 compose (multi-file upload)
app.use('/api/video-v2', express.json({ limit: '100mb' }));
app.use('/api/video-v2', express.urlencoded({ extended: true, limit: '100mb' }));

// Increase limit for test API (photo batch can be large)
app.use('/api/test', express.json({ limit: '100mb' }));
app.use('/api/test', express.urlencoded({ extended: true, limit: '100mb' }));

// Global body parser with default 10mb limit (for all other routes)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploaded files
app.use('/uploads', express.static(STORAGE_PATH));

// Serve test uploads (for FirmTestPage)
app.use('/uploads/test', express.static(path.join(STORAGE_PATH, 'test')));

// Initialize services
const roomManager = new RoomManager();
const imageMerger = new ImageMerger(STORAGE_PATH);
const signalingServer = new SignalingServer(server, roomManager);

// Ensure upload directory exists
imageMerger.ensureUploadDir().catch(console.error);

// Routes
app.get('/', (req, res) => {
  res.json({
    service: 'VShot v2 Server',
    version: '1.0.0',
    endpoints: {
      signaling: '/signaling (WebSocket)',
      photo: {
        upload: 'POST /api/photo/upload',
        merge: 'POST /api/photo/merge',
        getRoomPhotos: 'GET /api/photo/room/:roomId'
      }
    },
    status: {
      connectedClients: signalingServer.getConnectedClients(),
      activeRooms: roomManager.getRoomCount()
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ICE Servers configuration endpoint (requires authentication)
app.get('/api/ice-servers', apiKeyAuth, (req, res) => {
  const iceServers: Array<{ urls: string; username?: string; credential?: string }> = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // Add TURN server if configured
  if (process.env.TURN_SERVER_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_SERVER_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
    console.log('[API] TURN server configured');
  }

  res.json({ iceServers });
});

// API Routes (protected with API key authentication)
app.use('/api/photo', apiKeyAuth, createPhotoRouter(imageMerger, roomManager, signalingServer));
app.use('/api/video', apiKeyAuth, createVideoRouter(signalingServer));

// Video V2 API Routes (server-side FFmpeg composition)
app.use('/api/video-v2', apiKeyAuth, createVideoV2Router(signalingServer, roomManager));

// Test API Routes (for FirmTestPage - independent of RoomManager)
app.use('/api/test', apiKeyAuth, createTestProcessRouter(imageMerger));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[Server] Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║       VShot v2 Server Started         ║
╠═══════════════════════════════════════╣
║ HTTP API:  http://localhost:${PORT}    ║
║ WebSocket: ws://localhost:${PORT}/signaling
╚═══════════════════════════════════════╝
  `);
  console.log(`[Server] CORS enabled for: ${CORS_ORIGIN}`);
  console.log(`[Server] Storage path: ${STORAGE_PATH}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, closing server...');
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, closing server...');
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});
