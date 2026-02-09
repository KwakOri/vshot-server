import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { SignalingServer } from './services/SignalingServer';
import { RoomManager } from './services/RoomManager';
import { ImageMerger } from './services/ImageMerger';
import { V3RoomManager } from './services/v3/V3RoomManager.js';
import { V3SignalingServer } from './services/v3/V3SignalingServer.js';
import { createPhotoRouter } from './routes/photo';
import { createPhotoV3Router } from './routes/photo-v3.js';
import { createVideoRouter } from './routes/video';
import { createTestProcessRouter } from './routes/test-process';
import { createVideoV2Router } from './routes/video-v2';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import { authRouter } from './routes/auth';
import WebSocket from 'ws';

// Load environment variables
const envPath = path.resolve(__dirname, '../.env');
const envResult = dotenv.config({ path: envPath });
console.log(`[Env] Loading from: ${envPath}`);
console.log(`[Env] dotenv result: ${envResult.error ? envResult.error.message : 'OK'}`);
console.log(`[Env] SUPABASE_URL: ${process.env.SUPABASE_URL ? 'SET' : 'MISSING'}`);
console.log(`[Env] JWT_SECRET: ${process.env.JWT_SECRET ? 'SET' : 'MISSING'}`);

const app = express();
const server = http.createServer(app);

// Configuration
const PORT = process.env.PORT || 3001;
const CORS_ORIGINS = [
  'http://localhost:3000',
  'https://vshot.site',
];
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, '../uploads');

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g., mobile apps, curl)
    if (!origin) return callback(null, true);

    if (CORS_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
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
const signalingServer = new SignalingServer(roomManager);

// V3 Services
const v3RoomManager = new V3RoomManager();
const v3SignalingServer = new V3SignalingServer(v3RoomManager);

// V3 WebSocket server on /signaling-v3
const wssV3 = new WebSocket.Server({ noServer: true });
wssV3.on('connection', (ws) => {
  v3SignalingServer.handleConnection(ws);
});

// Route WebSocket upgrade requests by path
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

  if (pathname === '/signaling') {
    signalingServer.handleUpgrade(request, socket, head);
  } else if (pathname === '/signaling-v3') {
    wssV3.handleUpgrade(request, socket, head, (ws) => {
      wssV3.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Ensure upload directory exists
imageMerger.ensureUploadDir().catch(console.error);

// Routes
app.get('/', (req, res) => {
  res.json({
    service: 'VShot v2 Server',
    version: '1.0.0',
    endpoints: {
      signaling: '/signaling (WebSocket)',
      signalingV3: '/signaling-v3 (WebSocket - v3)',
      photo: {
        upload: 'POST /api/photo/upload',
        merge: 'POST /api/photo/merge',
        getRoomPhotos: 'GET /api/photo/room/:roomId'
      }
    },
    status: {
      v2: {
        connectedClients: signalingServer.getConnectedClients(),
        activeRooms: roomManager.getRoomCount()
      },
      v3: v3SignalingServer.getStats()
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

// Auth Routes (no API key required)
app.use('/api/auth', authRouter);

// API Routes (protected with API key authentication)
app.use('/api/photo', apiKeyAuth, createPhotoRouter(imageMerger, roomManager, signalingServer));
app.use('/api/photo-v3', apiKeyAuth, createPhotoV3Router(imageMerger, v3RoomManager, v3SignalingServer));
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
╔═══════════════════════════════════════════════╗
║         VShot v2/v3 Server Started            ║
╠═══════════════════════════════════════════════╣
║ HTTP API:    http://localhost:${PORT}         ║
║ WebSocket v2: ws://localhost:${PORT}/signaling    ║
║ WebSocket v3: ws://localhost:${PORT}/signaling-v3 ║
╚═══════════════════════════════════════════════╝
  `);
  console.log(`[Server] CORS enabled for: ${CORS_ORIGINS.join(', ')}`);
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
