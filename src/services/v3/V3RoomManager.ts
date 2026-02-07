import { V3Room, V3Session, HostSettings } from '../../types/signal.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * V3RoomManager - Manages rooms and sessions for VShot v3
 *
 * Key Concepts:
 * - Room: Persistent container created by Host, maintains Host settings
 * - Session: Temporary 1:1 capture between Host and Guest
 * - Guest Rotation: Guests can join/leave without affecting Host state
 */
export class V3RoomManager {
  private rooms: Map<string, V3Room> = new Map();

  /**
   * Create a new room with Host
   */
  createRoom(roomId: string, hostId: string, initialSettings: HostSettings): V3Room {
    const room: V3Room = {
      roomId,
      hostId,
      currentGuestId: null,
      hostSettings: initialSettings,
      completedSessions: [],
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };

    this.rooms.set(roomId, room);
    console.log(`[V3RoomManager] Room created: ${roomId} by Host: ${hostId}`);
    return room;
  }

  /**
   * Get room by ID
   */
  getRoom(roomId: string): V3Room | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Update Host settings (persisted across guest rotations)
   */
  updateHostSettings(roomId: string, settings: Partial<HostSettings>): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    room.hostSettings = {
      ...room.hostSettings,
      ...settings,
    };
    room.lastActivityAt = new Date();

    console.log(`[V3RoomManager] Host settings updated for room: ${roomId}`);
    return true;
  }

  /**
   * Guest joins the room - creates a new session
   */
  joinGuest(roomId: string, guestId: string): V3Session | null {
    const room = this.rooms.get(roomId);
    if (!room) {
      console.error(`[V3RoomManager] Room not found: ${roomId}`);
      return null;
    }

    // Only allow one guest at a time
    if (room.currentGuestId) {
      console.warn(`[V3RoomManager] Room ${roomId} already has a guest: ${room.currentGuestId}`);
      return null;
    }

    // Create new session
    const session: V3Session = {
      sessionId: uuidv4(),
      guestId,
      hostPhotoUrl: null,
      guestPhotoUrl: null,
      mergedPhotoUrl: null,
      frameResultUrl: null,
      status: 'in_progress',
      createdAt: new Date(),
      completedAt: null,
    };

    room.currentGuestId = guestId;
    room.completedSessions.push(session);
    room.lastActivityAt = new Date();

    console.log(`[V3RoomManager] Guest ${guestId} joined room ${roomId}, session: ${session.sessionId}`);
    return session;
  }

  /**
   * Guest leaves the room - ends current session
   * CRITICAL: Room and Host settings are preserved!
   */
  leaveGuest(roomId: string, guestId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.currentGuestId !== guestId) {
      return false;
    }

    // Mark current session as completed (if not already)
    const currentSession = this.getCurrentSession(roomId);
    if (currentSession && currentSession.status === 'in_progress') {
      currentSession.status = 'completed';
      currentSession.completedAt = new Date();
    }

    // Clear current guest (Room persists!)
    room.currentGuestId = null;
    room.lastActivityAt = new Date();

    console.log(`[V3RoomManager] Guest ${guestId} left room ${roomId}. Room and Host settings preserved.`);
    return true;
  }

  /**
   * Get current active session for a room
   */
  getCurrentSession(roomId: string): V3Session | null {
    const room = this.rooms.get(roomId);
    if (!room || !room.currentGuestId) return null;

    // Find the latest session for current guest
    const sessions = room.completedSessions.filter(
      s => s.guestId === room.currentGuestId && s.status === 'in_progress'
    );

    return sessions[sessions.length - 1] || null;
  }

  /**
   * Update session photo URLs
   */
  updateSessionPhoto(
    roomId: string,
    role: 'host' | 'guest',
    photoUrl: string
  ): boolean {
    const session = this.getCurrentSession(roomId);
    if (!session) return false;

    if (role === 'host') {
      session.hostPhotoUrl = photoUrl;
    } else {
      session.guestPhotoUrl = photoUrl;
    }

    const room = this.rooms.get(roomId);
    if (room) {
      room.lastActivityAt = new Date();
    }

    console.log(`[V3RoomManager] ${role} photo uploaded for session: ${session.sessionId}`);
    return true;
  }

  /**
   * Check if both photos are uploaded (ready for merge)
   */
  isSessionReadyForMerge(roomId: string): boolean {
    const session = this.getCurrentSession(roomId);
    if (!session) return false;

    return !!(session.hostPhotoUrl && session.guestPhotoUrl);
  }

  /**
   * Update session with merged photo URL
   */
  updateSessionMergedPhoto(roomId: string, mergedPhotoUrl: string): boolean {
    const session = this.getCurrentSession(roomId);
    if (!session) return false;

    session.mergedPhotoUrl = mergedPhotoUrl;

    const room = this.rooms.get(roomId);
    if (room) {
      room.lastActivityAt = new Date();
    }

    console.log(`[V3RoomManager] Merged photo updated for session: ${session.sessionId}`);
    return true;
  }

  /**
   * Complete session with final frame result
   */
  completeSession(roomId: string, frameResultUrl: string): V3Session | null {
    const session = this.getCurrentSession(roomId);
    if (!session) return null;

    session.frameResultUrl = frameResultUrl;
    session.status = 'completed';
    session.completedAt = new Date();

    const room = this.rooms.get(roomId);
    if (room) {
      room.lastActivityAt = new Date();
    }

    console.log(`[V3RoomManager] Session completed: ${session.sessionId}`);
    return session;
  }

  /**
   * Get all completed sessions for a room
   */
  getCompletedSessions(roomId: string): V3Session[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];

    return room.completedSessions.filter(s => s.status === 'completed');
  }

  /**
   * Host leaves - destroy room
   */
  destroyRoom(roomId: string): boolean {
    const deleted = this.rooms.delete(roomId);
    if (deleted) {
      console.log(`[V3RoomManager] Room destroyed: ${roomId}`);
    }
    return deleted;
  }

  /**
   * Check if user is the Host of a room
   */
  isHost(roomId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);
    return room?.hostId === userId;
  }

  /**
   * Get room statistics
   */
  getRoomStats(roomId: string): {
    totalSessions: number;
    completedSessions: number;
    currentGuest: string | null;
  } | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    return {
      totalSessions: room.completedSessions.length,
      completedSessions: room.completedSessions.filter(s => s.status === 'completed').length,
      currentGuest: room.currentGuestId,
    };
  }

  /**
   * Cleanup old rooms (optional - for production)
   */
  cleanupOldRooms(maxAgeHours: number = 24): number {
    const now = new Date();
    const maxAge = maxAgeHours * 60 * 60 * 1000; // Convert to milliseconds
    let cleanedCount = 0;

    for (const [roomId, room] of this.rooms.entries()) {
      const age = now.getTime() - room.lastActivityAt.getTime();
      if (age > maxAge) {
        this.rooms.delete(roomId);
        cleanedCount++;
        console.log(`[V3RoomManager] Cleaned up old room: ${roomId}`);
      }
    }

    return cleanedCount;
  }

  /**
   * Get all rooms (for debugging)
   */
  getAllRooms(): V3Room[] {
    return Array.from(this.rooms.values());
  }
}
