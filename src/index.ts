import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import * as os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { SignalingServer } from './services/SignalingServer';
import { RoomManager } from './services/RoomManager';
import { ImageMerger } from './services/ImageMerger';
import { V3RoomManager } from './services/v3/V3RoomManager.js';
import { V3SignalingServer } from './services/v3/V3SignalingServer.js';
import { createPhotoV3Router } from './routes/photo-v3.js';
import { apiKeyAuth, internalStatusApiKeyAuth } from './middleware/apiKeyAuth';
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
const eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelayMonitor.enable();

function bytesToMb(bytes: number): number {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function nanosecondsToMs(nanoseconds: number): number | null {
  if (!Number.isFinite(nanoseconds)) {
    return null;
  }

  return Number((nanoseconds / 1_000_000).toFixed(2));
}

function getV2StatusSnapshot() {
  const rooms = roomManager.getAllRooms();

  return {
    connectedClients: signalingServer.getConnectedClients(),
    activeRooms: rooms.length,
    occupiedRooms: rooms.filter(room => !!room.guestId).length,
    waitingRooms: rooms.filter(room => !room.guestId).length,
    roomsPendingDeletion: rooms.filter(room => !!room.deletionTimerId).length,
    capturedPhotos: rooms.reduce((total, room) => total + room.capturedPhotos.length, 0),
    uploadedSegments: rooms.reduce((total, room) => total + room.uploadedSegments.length, 0),
  };
}

function getV3StatusSnapshot() {
  const rooms = v3RoomManager.getAllRooms();
  const roomsByMode = { v3: 0, festa: 0, photo: 0 };

  rooms.forEach(room => {
    roomsByMode[room.mode]++;
  });

  const sessions = rooms.flatMap(room => room.completedSessions);

  return {
    connectedClients: v3SignalingServer.getStats().connectedClients,
    activeRooms: rooms.length,
    occupiedRooms: rooms.filter(room => !!room.currentGuestId).length,
    waitingRooms: rooms.filter(room => !room.currentGuestId).length,
    roomsByMode,
    sessions: {
      total: sessions.length,
      inProgress: sessions.filter(session => session.status === 'in_progress').length,
      completed: sessions.filter(session => session.status === 'completed').length,
      mergeStatus: {
        none: sessions.filter(session => session.mergeStatus === 'none').length,
        provisional: sessions.filter(session => session.mergeStatus === 'provisional').length,
        final: sessions.filter(session => session.mergeStatus === 'final').length,
      },
    },
  };
}

function getInternalStatusSnapshot() {
  const memoryUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  const [load1m, load5m, load15m] = os.loadavg();

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSec: Number(process.uptime().toFixed(2)),
      memoryMb: {
        rss: bytesToMb(memoryUsage.rss),
        heapTotal: bytesToMb(memoryUsage.heapTotal),
        heapUsed: bytesToMb(memoryUsage.heapUsed),
        external: bytesToMb(memoryUsage.external),
        arrayBuffers: bytesToMb(memoryUsage.arrayBuffers),
      },
      cpuUsageMicros: {
        user: cpuUsage.user,
        system: cpuUsage.system,
      },
      loadAverage: {
        '1m': Number(load1m.toFixed(2)),
        '5m': Number(load5m.toFixed(2)),
        '15m': Number(load15m.toFixed(2)),
      },
      eventLoopDelayMs: {
        min: nanosecondsToMs(eventLoopDelayMonitor.min),
        mean: nanosecondsToMs(eventLoopDelayMonitor.mean),
        max: nanosecondsToMs(eventLoopDelayMonitor.max),
        p95: nanosecondsToMs(eventLoopDelayMonitor.percentile(95)),
      },
    },
    configuration: {
      turnConfigured: !!(process.env.TURN_SERVER_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL),
      supabaseConfigured: !!process.env.SUPABASE_URL,
      jwtConfigured: !!process.env.JWT_SECRET,
      apiKeyConfigured: !!process.env.API_KEY,
      internalStatusApiKeyConfigured: !!process.env.INTERNAL_STATUS_API_KEY,
    },
    rooms: {
      v2: getV2StatusSnapshot(),
      v3: getV3StatusSnapshot(),
    },
  };
}

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
      internal: {
        status: 'GET /api/internal/status (X-Internal-Status-Key required)',
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

app.get('/api/internal/status', internalStatusApiKeyAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(getInternalStatusSnapshot());
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
