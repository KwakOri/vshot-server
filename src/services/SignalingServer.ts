import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { SignalMessage } from '../types/signal';
import { RoomManager } from './RoomManager';

interface ClientConnection {
  ws: WebSocket;
  userId: string;
  roomId: string | null;
  role: 'host' | 'guest' | null;
}

export class SignalingServer {
  private wss: WebSocketServer;
  private clients: Map<string, ClientConnection> = new Map();
  private roomManager: RoomManager;

  constructor(server: HttpServer, roomManager: RoomManager) {
    this.wss = new WebSocketServer({ server, path: '/signaling' });
    this.roomManager = roomManager;
    this.initialize();
  }

  private initialize(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      console.log('[Signaling] New connection');

      ws.on('message', (data: Buffer) => {
        try {
          const message: SignalMessage = JSON.parse(data.toString());
          this.handleMessage(ws, message);
        } catch (error) {
          console.error('[Signaling] Error parsing message:', error);
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(ws);
      });

      ws.on('error', (error) => {
        console.error('[Signaling] WebSocket error:', error);
      });
    });

    console.log('[Signaling] Server initialized');
  }

  private handleMessage(ws: WebSocket, message: SignalMessage): void {
    console.log('[Signaling] Received:', message.type);

    switch (message.type) {
      case 'join':
        this.handleJoin(ws, message);
        break;
      case 'offer':
      case 'answer':
      case 'ice':
        this.handleWebRTCSignal(message);
        break;
      case 'leave':
        this.handleLeave(message);
        break;
      case 'photo-session-start':
        this.handlePhotoSessionStart(message);
        break;
      case 'countdown-tick':
        this.handleCountdownTick(message);
        break;
      case 'capture-now':
        this.handleCaptureNow(message);
        break;
      case 'capture-request':
        this.handleCaptureRequest(message);
        break;
      case 'capture-uploaded':
        this.handleCaptureUploaded(message);
        break;
      case 'photo-select':
        this.handlePhotoSelect(message);
        break;
      case 'chromakey-settings':
        this.handleChromakeySettings(message);
        break;
      case 'session-settings':
        this.handleSessionSettings(message);
        break;
      case 'video-frame-request':
        this.handleVideoFrameRequest(message);
        break;
      case 'host-display-options':
        this.handleHostDisplayOptions(message);
        break;
      case 'guest-display-options':
        this.handleGuestDisplayOptions(message);
        break;
      case 'aspect-ratio-settings':
        this.handleAspectRatioSettings(message);
        break;
      case 'frame-layout-settings':
        this.handleFrameLayoutSettings(message);
        break;
      default:
        console.warn('[Signaling] Unknown message type:', message);
    }
  }

  private handleJoin(ws: WebSocket, message: { type: 'join'; roomId: string; userId: string; role: 'host' | 'guest' }): void {
    const { roomId, userId, role } = message;

    // Check if user already connected
    if (this.clients.has(userId)) {
      ws.send(JSON.stringify({ type: 'error', message: 'User already connected' }));
      return;
    }

    let success = false;
    let finalRoomId = roomId;

    if (role === 'host') {
      // Check if host is trying to rejoin an existing room
      if (roomId && roomId.trim() !== '') {
        success = this.roomManager.rejoinRoomAsHost(roomId, userId);

        if (success) {
          // Successfully rejoined existing room
          finalRoomId = roomId;
        } else {
          // Rejoin failed - create new room
          finalRoomId = this.roomManager.createRoom(userId);
          success = true;
        }
      } else {
        // No roomId provided - create new room
        finalRoomId = this.roomManager.createRoom(userId);
        success = true;
      }

      if (success) {
        this.clients.set(userId, { ws, userId, roomId: finalRoomId, role: 'host' });

        const room = this.roomManager.getRoom(finalRoomId);
        const response: any = {
          type: 'joined',
          roomId: finalRoomId,
          role: 'host',
          userId
        };

        // If there's a guest in the room (after rejoin), notify host
        if (room && room.guestId) {
          response.guestId = room.guestId;
        }

        ws.send(JSON.stringify(response));
      }
    } else {
      // Guest joins existing room
      success = this.roomManager.joinRoom(roomId, userId);

      if (success) {
        this.clients.set(userId, { ws, userId, roomId, role: 'guest' });

        const room = this.roomManager.getRoom(roomId);
        if (room) {
          // Notify host
          const hostClient = this.clients.get(room.hostId);
          if (hostClient) {
            hostClient.ws.send(JSON.stringify({
              type: 'peer-joined',
              userId,
              role: 'guest'
            }));
          }

          // Notify guest
          ws.send(JSON.stringify({
            type: 'joined',
            roomId,
            role: 'guest',
            userId,
            hostId: room.hostId
          }));
        }
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Failed to join room. Room may not exist or is full.'
        }));
      }
    }

    console.log(`[Signaling] ${role} ${userId} ${success ? 'joined' : 'failed to join'} room ${finalRoomId || roomId}`);
  }

  private handleWebRTCSignal(message: { roomId: string; from: string; to: string } & any): void {
    const { to } = message;
    const targetClient = this.clients.get(to);

    if (targetClient) {
      targetClient.ws.send(JSON.stringify(message));
      console.log(`[Signaling] Forwarded ${message.type} from ${message.from} to ${to}`);
    } else {
      console.warn(`[Signaling] Target client not found: ${to}`);
    }
  }

  private handleLeave(message: { type: 'leave'; roomId: string; userId: string }): void {
    const { userId, roomId } = message;

    const roomIdRemoved = this.roomManager.removeUser(userId);

    if (roomIdRemoved) {
      // Notify other users in the room
      const room = this.roomManager.getRoom(roomIdRemoved);
      if (room) {
        const otherUserId = room.hostId === userId ? room.guestId : room.hostId;
        if (otherUserId) {
          const otherClient = this.clients.get(otherUserId);
          if (otherClient) {
            otherClient.ws.send(JSON.stringify({
              type: 'peer-left',
              userId
            }));
          }
        }
      }
    }

    this.clients.delete(userId);
    console.log(`[Signaling] User ${userId} left room ${roomId}`);
  }

  private handlePhotoSessionStart(message: { type: 'photo-session-start'; roomId: string }): void {
    const { roomId } = message;

    // Broadcast to all clients in the room
    this.broadcastToRoom(roomId, {
      type: 'photo-session-start',
      roomId
    });

    console.log(`[Signaling] Photo session started in room ${roomId}`);
  }

  private handleCountdownTick(message: { type: 'countdown-tick'; roomId: string; count: number; photoNumber: number }): void {
    const { roomId, count, photoNumber } = message;

    // Broadcast countdown to all clients
    this.broadcastToRoom(roomId, {
      type: 'countdown-tick',
      roomId,
      count,
      photoNumber
    });

    console.log(`[Signaling] Countdown ${count} for photo ${photoNumber} in room ${roomId}`);
  }

  private handleCaptureNow(message: { type: 'capture-now'; roomId: string; photoNumber: number }): void {
    const { roomId, photoNumber } = message;

    // Add photo to room
    this.roomManager.addCapturedPhoto(roomId, photoNumber);

    // Broadcast capture signal to all clients
    this.broadcastToRoom(roomId, {
      type: 'capture-now',
      roomId,
      photoNumber
    });

    console.log(`[Signaling] Capture now for photo ${photoNumber} in room ${roomId}`);
  }

  private handleCaptureRequest(message: { type: 'capture-request'; roomId: string; photoNumber: number }): void {
    const { roomId, photoNumber } = message;

    // Add photo to room
    this.roomManager.addCapturedPhoto(roomId, photoNumber);

    // Broadcast to all clients in the room
    this.broadcastToRoom(roomId, {
      type: 'capture-request',
      roomId,
      photoNumber
    });

    console.log(`[Signaling] Capture request for photo ${photoNumber} in room ${roomId}`);
  }

  private handleCaptureUploaded(message: { type: 'capture-uploaded'; roomId: string; userId: string; url: string; photoNumber: number }): void {
    const { roomId, userId, url, photoNumber } = message;

    const client = this.clients.get(userId);
    if (!client || !client.role) return;

    this.roomManager.updatePhotoUrl(roomId, photoNumber, client.role, url);

    // Broadcast to room
    this.broadcastToRoom(roomId, {
      type: 'capture-uploaded',
      roomId,
      userId,
      role: client.role,
      url,
      photoNumber
    });

    console.log(`[Signaling] ${client.role} uploaded photo ${photoNumber}`);
  }

  private handlePhotoSelect(message: { type: 'photo-select'; roomId: string; userId: string; selectedIndices: number[] }): void {
    const { roomId, userId, selectedIndices } = message;

    const client = this.clients.get(userId);
    if (!client || !client.role) return;

    this.roomManager.updateSelectedPhotos(roomId, client.role, selectedIndices);

    // Broadcast to room
    this.broadcastToRoom(roomId, {
      type: 'photo-select-sync',
      roomId,
      userId,
      role: client.role,
      selectedIndices
    });

    console.log(`[Signaling] ${client.role} selected photos:`, selectedIndices);
  }

  private handleChromakeySettings(message: { type: 'chromakey-settings'; roomId: string; settings: any }): void {
    const { roomId, settings } = message;

    // Broadcast chromakey settings to all clients in the room
    this.broadcastToRoom(roomId, {
      type: 'chromakey-settings',
      roomId,
      settings
    });

    console.log(`[Signaling] Chromakey settings updated in room ${roomId}:`, settings);
  }

  private handleSessionSettings(message: { type: 'session-settings'; roomId: string; settings: { recordingDuration: number; captureInterval: number } }): void {
    const { roomId, settings } = message;

    // Store session settings in room
    this.roomManager.updateSessionSettings(roomId, settings);

    // Broadcast session settings to all clients in the room
    this.broadcastToRoom(roomId, {
      type: 'session-settings',
      roomId,
      settings
    });

    console.log(`[Signaling] Session settings updated in room ${roomId}:`, settings);
  }

  private handleVideoFrameRequest(message: { type: 'video-frame-request'; roomId: string; userId: string; selectedPhotos: number[] }): void {
    const { roomId, userId, selectedPhotos } = message;

    console.log(`[Signaling] Video frame request from ${userId} in room ${roomId}`);
    console.log(`[Signaling] Selected photos:`, selectedPhotos);

    // Broadcast to room (Host will receive this and start composition)
    this.broadcastToRoom(roomId, {
      type: 'video-frame-request',
      roomId,
      fromUserId: userId,
      selectedPhotos
    });
  }

  private handleHostDisplayOptions(message: { type: 'host-display-options'; roomId: string; options: { flipHorizontal: boolean } }): void {
    const { roomId, options } = message;

    // Broadcast host display options to all clients in the room
    this.broadcastToRoom(roomId, {
      type: 'host-display-options',
      roomId,
      options
    });

    console.log(`[Signaling] Host display options updated in room ${roomId}:`, options);
  }

  private handleGuestDisplayOptions(message: { type: 'guest-display-options'; roomId: string; options: { flipHorizontal: boolean } }): void {
    const { roomId, options } = message;

    // Broadcast guest display options to all clients in the room
    this.broadcastToRoom(roomId, {
      type: 'guest-display-options',
      roomId,
      options
    });

    console.log(`[Signaling] Guest display options updated in room ${roomId}:`, options);
  }

  private handleAspectRatioSettings(message: { type: 'aspect-ratio-settings'; roomId: string; settings: any }): void {
    const { roomId, settings } = message;

    // Store aspect ratio settings in room
    this.roomManager.updateAspectRatioSettings(roomId, settings);

    // Broadcast aspect ratio settings to all clients in the room
    this.broadcastToRoom(roomId, {
      type: 'aspect-ratio-settings',
      roomId,
      settings
    });

    console.log(`[Signaling] Aspect ratio settings updated in room ${roomId}:`, settings);
  }

  private handleFrameLayoutSettings(message: { type: 'frame-layout-settings'; roomId: string; settings: any }): void {
    const { roomId, settings } = message;

    // Store frame layout settings in room
    this.roomManager.updateFrameLayoutSettings(roomId, settings);

    // Broadcast frame layout settings to all clients in the room
    this.broadcastToRoom(roomId, {
      type: 'frame-layout-settings',
      roomId,
      settings
    });

    console.log(`[Signaling] Frame layout settings updated in room ${roomId}:`, settings);
  }

  private handleDisconnect(ws: WebSocket): void {
    // Find and remove the disconnected client
    let disconnectedUserId: string | null = null;

    for (const [userId, client] of this.clients.entries()) {
      if (client.ws === ws) {
        disconnectedUserId = userId;
        break;
      }
    }

    if (disconnectedUserId) {
      const client = this.clients.get(disconnectedUserId);
      if (client && client.roomId) {
        this.handleLeave({
          type: 'leave',
          roomId: client.roomId,
          userId: disconnectedUserId
        });
      }
      console.log(`[Signaling] Client disconnected: ${disconnectedUserId}`);
    }
  }

  public broadcastToRoom(roomId: string, message: any): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room) return;

    const userIds = [room.hostId, room.guestId].filter(Boolean) as string[];

    userIds.forEach(userId => {
      const client = this.clients.get(userId);
      if (client && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    });
  }

  getConnectedClients(): number {
    return this.clients.size;
  }
}
