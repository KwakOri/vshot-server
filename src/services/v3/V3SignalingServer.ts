import WebSocket from 'ws';
import { SignalMessage, HostSettings } from '../../types/signal.js';
import { V3RoomManager } from './V3RoomManager.js';

interface Client {
  ws: WebSocket;
  userId: string;
  roomId: string;
  role: 'host' | 'guest';
}

/**
 * V3SignalingServer - WebSocket server for VShot v3
 *
 * Handles:
 * - WebRTC signaling (offer/answer/ICE)
 * - Guest rotation (guest join/leave while preserving Host)
 * - Single-shot capture coordination
 * - Host settings synchronization
 */
export class V3SignalingServer {
  private clients: Map<string, Client> = new Map(); // userId -> Client
  private roomManager: V3RoomManager;

  constructor(roomManager: V3RoomManager) {
    this.roomManager = roomManager;
  }

  /**
   * Handle new WebSocket connection
   */
  handleConnection(ws: WebSocket): void {
    console.log('[V3Signaling] New connection');

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString()) as SignalMessage;
        this.handleMessage(ws, message);
      } catch (error) {
        console.error('[V3Signaling] Failed to parse message:', error);
        this.sendError(ws, 'Invalid message format');
      }
    });

    ws.on('close', () => {
      this.handleDisconnect(ws);
    });

    ws.on('error', (error) => {
      console.error('[V3Signaling] WebSocket error:', error);
    });
  }

  /**
   * Route incoming messages
   */
  private handleMessage(ws: WebSocket, message: SignalMessage): void {
    switch (message.type) {
      // V3 Room/Session Management
      case 'join':
        this.handleJoin(ws, message);
        break;
      case 'leave':
        this.handleLeave(message);
        break;

      // WebRTC Signaling (standard)
      case 'offer':
      case 'answer':
      case 'ice':
        this.forwardToRoom(message);
        break;

      // V3 Frame Selection
      case 'frame-selected-v3':
        this.handleFrameSelected(message);
        break;

      // V3 Capture Flow
      case 'start-capture-v3':
        this.handleStartCapture(message);
        break;
      case 'photo-uploaded-v3':
        this.handlePhotoUploaded(message);
        break;

      // V3 Host Settings Sync
      case 'host-settings-sync-v3':
        this.handleHostSettingsSync(message);
        break;

      // Festa session reset
      case 'session-reset-festa':
        this.handleSessionResetFesta(message);
        break;

      // Festa film ready / QR dismissed
      case 'film-ready-festa':
      case 'qr-dismissed-festa':
        this.broadcastToRoom(message.roomId, message);
        break;

      // Display settings forwarding (Host <-> Guest)
      case 'chromakey-settings':
      case 'host-display-options':
      case 'guest-display-options':
      case 'frame-layout-settings':
        this.forwardToPeer(ws, message);
        break;

      default:
        console.warn('[V3Signaling] Unknown message type:', (message as any).type);
    }
  }

  /**
   * Handle join - create room (Host) or join existing room (Guest)
   */
  private handleJoin(
    ws: WebSocket,
    message: Extract<SignalMessage, { type: 'join' }>
  ): void {
    const { roomId, userId, role, mode } = message;

    // Check if user already connected - handle reconnection
    const existingClient = this.clients.get(userId);
    if (existingClient) {
      // Same user reconnecting - close old connection and accept new one
      console.log(`[V3Signaling] User ${userId} reconnecting, closing old connection`);
      try {
        existingClient.ws.close(1000, 'Reconnecting');
      } catch (e) {
        // Ignore close errors
      }
      this.clients.delete(userId);
    }

    // Register client
    this.clients.set(userId, { ws, userId, roomId, role });

    if (role === 'host') {
      this.handleHostJoin(ws, roomId, userId, mode);
    } else {
      this.handleGuestJoin(ws, roomId, userId);
    }
  }

  /**
   * Host joins - create room with default settings
   */
  private handleHostJoin(ws: WebSocket, roomId: string, hostId: string, mode: 'v3' | 'festa' = 'v3'): void {
    // Check if room already exists
    let room = this.roomManager.getRoom(roomId);

    if (room) {
      // Room exists - verify host
      if (room.hostId !== hostId) {
        this.sendError(ws, 'Room already exists with different host');
        return;
      }
      console.log(`[V3Signaling] Host reconnected to room: ${roomId}`);
    } else {
      // Create new room with default settings
      const defaultSettings: HostSettings = {
        chromaKey: {
          enabled: true,
          color: '#00ff00',
          similarity: 0.4,
          smoothness: 0.1,
        },
        selectedFrameLayoutId: '1cut-polaroid', // Default frame
        recordingDuration: 10,
        captureInterval: 3,
      };

      room = this.roomManager.createRoom(roomId, hostId, defaultSettings, mode);
      console.log(`[V3Signaling] Host created room: ${roomId} (mode: ${mode})`);
    }

    // Send confirmation to Host
    this.send(ws, {
      type: 'joined',
      roomId,
      role: 'host',
      userId: hostId,
    });

    // If no guest, notify Host to wait
    if (!room.currentGuestId) {
      this.send(ws, {
        type: 'waiting-for-guest-v3',
        roomId,
      });
    }
  }

  /**
   * Guest joins - create session and sync Host settings
   */
  private handleGuestJoin(ws: WebSocket, roomId: string, guestId: string): void {
    const room = this.roomManager.getRoom(roomId);

    if (!room) {
      this.sendError(ws, 'Room not found');
      return;
    }

    // Attempt to join as guest (creates session)
    const session = this.roomManager.joinGuest(roomId, guestId);

    if (!session) {
      this.sendError(ws, 'Room already has a guest');
      return;
    }

    // Send confirmation to Guest with Host settings
    this.send(ws, {
      type: 'guest-joined-v3',
      roomId,
      guestId,
      hostSettings: room.hostSettings,
    });

    // Notify Host that Guest joined
    const hostClient = this.findClientByRole(roomId, 'host');
    if (hostClient) {
      this.send(hostClient.ws, {
        type: 'guest-joined-v3',
        roomId,
        guestId,
        hostSettings: room.hostSettings,
      });

      // Also send peer-joined for WebRTC setup
      this.send(hostClient.ws, {
        type: 'peer-joined',
        userId: guestId,
        role: 'guest',
      });
    }

    // Send peer-joined to Guest
    this.send(ws, {
      type: 'peer-joined',
      userId: room.hostId,
      role: 'host',
    });

    console.log(`[V3Signaling] Guest ${guestId} joined room ${roomId}, session: ${session.sessionId}`);
  }

  /**
   * Handle leave - preserve room for Host, complete session for Guest
   */
  private handleLeave(message: Extract<SignalMessage, { type: 'leave' }>): void {
    const { roomId, userId } = message;
    const client = this.clients.get(userId);

    if (!client) return;

    if (client.role === 'host') {
      // Host leaves - destroy room
      this.roomManager.destroyRoom(roomId);
      console.log(`[V3Signaling] Host left, room destroyed: ${roomId}`);

      // Notify guest if present
      const guestClient = this.findClientByRole(roomId, 'guest');
      if (guestClient) {
        this.send(guestClient.ws, {
          type: 'peer-left',
          userId,
        });
      }
    } else {
      // Guest leaves - end session, preserve room
      this.roomManager.leaveGuest(roomId, userId);

      // Notify Host
      const hostClient = this.findClientByRole(roomId, 'host');
      if (hostClient) {
        this.send(hostClient.ws, {
          type: 'guest-left-v3',
          roomId,
          guestId: userId,
        });

        this.send(hostClient.ws, {
          type: 'waiting-for-guest-v3',
          roomId,
        });

        this.send(hostClient.ws, {
          type: 'peer-left',
          userId,
        });
      }

      console.log(`[V3Signaling] Guest left, room preserved: ${roomId}`);
    }

    // Remove client
    this.clients.delete(userId);
  }

  /**
   * Handle disconnect
   */
  private handleDisconnect(ws: WebSocket): void {
    // Find client by WebSocket
    const client = Array.from(this.clients.values()).find(c => c.ws === ws);
    if (!client) return;

    console.log(`[V3Signaling] Client disconnected: ${client.userId}`);

    // Simulate leave
    this.handleLeave({
      type: 'leave',
      roomId: client.roomId,
      userId: client.userId,
    });
  }

  /**
   * Handle frame selection (Host only)
   */
  private handleFrameSelected(
    message: Extract<SignalMessage, { type: 'frame-selected-v3' }>
  ): void {
    const { roomId, layoutId } = message;

    // Update Host settings
    this.roomManager.updateHostSettings(roomId, {
      selectedFrameLayoutId: layoutId,
    });

    // Broadcast to room
    this.broadcastToRoom(roomId, message);

    console.log(`[V3Signaling] Frame selected in room ${roomId}: ${layoutId}`);
  }

  /**
   * Handle start capture - coordinate countdown
   */
  private handleStartCapture(
    message: Extract<SignalMessage, { type: 'start-capture-v3' }>
  ): void {
    const { roomId } = message;

    // Broadcast to room
    this.broadcastToRoom(roomId, message);

    // Start countdown (3-2-1)
    this.startCountdown(roomId);
  }

  /**
   * Countdown timer for capture
   */
  private async startCountdown(roomId: string): Promise<void> {
    for (let count = 5; count > 0; count--) {
      await this.sleep(1000);
      this.broadcastToRoom(roomId, {
        type: 'countdown-tick-v3',
        roomId,
        count,
      });
    }

    // Trigger capture
    await this.sleep(1000);
    this.broadcastToRoom(roomId, {
      type: 'capture-now-v3',
      roomId,
    });
  }

  /**
   * Handle photo uploaded
   */
  private handlePhotoUploaded(
    message: Extract<SignalMessage, { type: 'photo-uploaded-v3' }>
  ): void {
    const { roomId, userId, role, photoUrl } = message;

    // Update session
    const updated = this.roomManager.updateSessionPhoto(roomId, role, photoUrl);

    if (!updated) {
      console.error(`[V3Signaling] Failed to update photo for ${role} in room ${roomId}`);
      return;
    }

    // Check if both photos uploaded
    if (this.roomManager.isSessionReadyForMerge(roomId)) {
      console.log(`[V3Signaling] Both photos uploaded, triggering merge for room ${roomId}`);
      // Server will handle merge via API route
      // For now, just broadcast status
      this.broadcastToRoom(roomId, {
        type: 'photo-uploaded-v3',
        roomId,
        userId,
        role,
        photoUrl,
      });
    }
  }

  /**
   * Handle Festa session reset (keep connection, reset capture state)
   */
  private handleSessionResetFesta(
    message: Extract<SignalMessage, { type: 'session-reset-festa' }>
  ): void {
    const { roomId } = message;
    const newSession = this.roomManager.resetSessionForFesta(roomId);
    if (newSession) {
      this.broadcastToRoom(roomId, { type: 'session-reset-festa', roomId });
      console.log(`[V3Signaling] Festa session reset for room ${roomId}`);
    }
  }

  /**
   * Handle Host settings sync
   */
  private handleHostSettingsSync(
    message: Extract<SignalMessage, { type: 'host-settings-sync-v3' }>
  ): void {
    const { roomId, settings } = message;

    // Update Host settings
    this.roomManager.updateHostSettings(roomId, settings);

    // Broadcast to Guest
    const guestClient = this.findClientByRole(roomId, 'guest');
    if (guestClient) {
      this.send(guestClient.ws, message);
    }

    console.log(`[V3Signaling] Host settings synced for room ${roomId}`);
  }

  /**
   * Forward message to the other peer in the room
   */
  private forwardToPeer(senderWs: WebSocket, message: any): void {
    const sender = Array.from(this.clients.values()).find(c => c.ws === senderWs);
    if (!sender) return;

    const targetRole = sender.role === 'host' ? 'guest' : 'host';
    const target = this.findClientByRole(sender.roomId, targetRole);

    if (target) {
      this.send(target.ws, message);
      console.log(`[V3Signaling] Forwarded ${message.type} from ${sender.role} to ${targetRole} in room ${sender.roomId}`);
    }
  }

  /**
   * Forward WebRTC signaling messages
   */
  private forwardToRoom(
    message: Extract<SignalMessage, { type: 'offer' | 'answer' | 'ice' }>
  ): void {
    const { to } = message;
    const targetClient = this.clients.get(to);

    if (targetClient) {
      this.send(targetClient.ws, message);
    } else {
      console.warn(`[V3Signaling] Target client not found: ${to}`);
    }
  }

  /**
   * Broadcast message to all clients in a room
   * Public method for external use (e.g., from API routes)
   */
  broadcastToRoom(roomId: string, message: SignalMessage): void {
    for (const client of this.clients.values()) {
      if (client.roomId === roomId) {
        this.send(client.ws, message);
      }
    }
  }

  /**
   * Find client by role in room
   */
  private findClientByRole(roomId: string, role: 'host' | 'guest'): Client | undefined {
    return Array.from(this.clients.values()).find(
      c => c.roomId === roomId && c.role === role
    );
  }

  /**
   * Send message to client
   */
  private send(ws: WebSocket, message: SignalMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send error message
   */
  private sendError(ws: WebSocket, message: string): void {
    this.send(ws, { type: 'error', message });
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get room manager (for external access)
   */
  getRoomManager(): V3RoomManager {
    return this.roomManager;
  }

  /**
   * Get server stats
   */
  getStats(): {
    connectedClients: number;
    activeRooms: number;
  } {
    return {
      connectedClients: this.clients.size,
      activeRooms: this.roomManager.getAllRooms().length,
    };
  }
}
