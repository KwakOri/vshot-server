import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { SignalingServer } from './services/SignalingServer';
import { RoomManager } from './services/RoomManager';
import { ImageMerger } from './services/ImageMerger';
import { V3RoomManager } from './services/v3/V3RoomManager.js';
import { V3SignalingServer } from './services/v3/V3SignalingServer.js';
import { createPhotoV3Router } from './routes/photo-v3.js';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import { authRouter } from './routes/auth';
import { festaRouter } from './routes/festa';
import { framesRouter } from './routes/frames';
import { frameAccessRouter } from './routes/frame-access';
import { groupsRouter } from './routes/groups';
import WebSocket from 'ws';

// Env loaded via import 'dotenv/config' (first import)
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
app.use('/api/photo-v3/upload', express.json({ limit: '50mb' }));
app.use('/api/photo-v3/upload', express.urlencoded({ extended: true, limit: '50mb' }));

// Global body parser with default 10mb limit (for all other routes)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Initialize services
const roomManager = new RoomManager();
const imageMerger = new ImageMerger();
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

// Routes
app.get('/', (req, res) => {
  res.json({
    service: 'VShot v2 Server',
    version: '2.0.0',
    endpoints: {
      signaling: '/signaling (WebSocket)',
      signalingV3: '/signaling-v3 (WebSocket - v3)',
      photoV3: {
        upload: 'POST /api/photo-v3/upload',
        applyFrame: 'POST /api/photo-v3/apply-frame',
        session: 'GET /api/photo-v3/session/:roomId'
      },
      frames: {
        list: 'GET /api/frames',
        create: 'POST /api/frames',
        update: 'PUT /api/frames/:id',
        delete: 'DELETE /api/frames/:id',
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
app.use('/api/photo-v3', apiKeyAuth, createPhotoV3Router(imageMerger, v3RoomManager, v3SignalingServer));

// Festa API Routes (file upload + film creation via Express, bypassing Vercel)
app.use('/api/festa', apiKeyAuth, festaRouter);

// Frame Management API Routes (JWT auth, no API key needed)
app.use('/api/frames', framesRouter);
app.use('/api/frame-access', frameAccessRouter);
app.use('/api/groups', groupsRouter);

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
  const serverUrl = process.env.SERVER_URL;
  const host = serverUrl || `localhost:${PORT}`;
  const httpProto = serverUrl ? 'https' : 'http';
  const wsProto = serverUrl ? 'wss' : 'ws';

  console.log(`
╔═══════════════════════════════════════════════════╗
║           VShot v2/v3 Server Started              ║
╠═══════════════════════════════════════════════════╣
║ HTTP API:     ${httpProto}://${host}
║ WebSocket v2: ${wsProto}://${host}/signaling
║ WebSocket v3: ${wsProto}://${host}/signaling-v3
╚═══════════════════════════════════════════════════╝
  `);
  console.log(`[Server] CORS enabled for: ${CORS_ORIGINS.join(', ')}`);
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
