import { Room, CapturedPhoto } from '../types/signal';
import { v4 as uuidv4 } from 'uuid';

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private userToRoom: Map<string, string> = new Map(); // userId -> roomId

  createRoom(hostId: string): string {
    const roomId = this.generateRoomId();
    const room: Room = {
      id: roomId,
      hostId,
      guestId: null,
      createdAt: new Date(),
      capturedPhotos: [],
      selectedPhotos: {
        host: [],
        guest: []
      }
    };

    this.rooms.set(roomId, room);
    this.userToRoom.set(hostId, roomId);

    console.log(`[RoomManager] Room created: ${roomId} by host: ${hostId}`);
    return roomId;
  }

  joinRoom(roomId: string, guestId: string): boolean {
    const room = this.rooms.get(roomId);

    if (!room) {
      console.log(`[RoomManager] Room not found: ${roomId}`);
      return false;
    }

    if (room.guestId && room.guestId !== guestId) {
      console.log(`[RoomManager] Room ${roomId} already has a guest`);
      return false;
    }

    room.guestId = guestId;
    this.userToRoom.set(guestId, roomId);

    console.log(`[RoomManager] Guest ${guestId} joined room: ${roomId}`);
    return true;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getRoomByUserId(userId: string): Room | undefined {
    const roomId = this.userToRoom.get(userId);
    return roomId ? this.rooms.get(roomId) : undefined;
  }

  addCapturedPhoto(roomId: string, photoNumber: number): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const photo: CapturedPhoto = {
      photoNumber,
      hostImageUrl: null,
      guestImageUrl: null,
      mergedImageUrl: null,
      timestamp: new Date()
    };

    room.capturedPhotos.push(photo);
    console.log(`[RoomManager] Photo ${photoNumber} added to room ${roomId}`);
  }

  updatePhotoUrl(roomId: string, photoNumber: number, role: 'host' | 'guest', url: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const photo = room.capturedPhotos.find(p => p.photoNumber === photoNumber);
    if (!photo) return;

    if (role === 'host') {
      photo.hostImageUrl = url;
    } else {
      photo.guestImageUrl = url;
    }

    console.log(`[RoomManager] ${role} image updated for photo ${photoNumber} in room ${roomId}`);
  }

  updateMergedPhotoUrl(roomId: string, photoNumber: number, url: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const photo = room.capturedPhotos.find(p => p.photoNumber === photoNumber);
    if (photo) {
      photo.mergedImageUrl = url;
      console.log(`[RoomManager] Merged image updated for photo ${photoNumber} in room ${roomId}`);
    }
  }

  updateSelectedPhotos(roomId: string, role: 'host' | 'guest', selectedIndices: number[]): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.selectedPhotos[role] = selectedIndices;
    console.log(`[RoomManager] ${role} selected photos updated:`, selectedIndices);
  }

  removeUser(userId: string): string | null {
    const roomId = this.userToRoom.get(userId);
    if (!roomId) return null;

    const room = this.rooms.get(roomId);
    if (!room) return null;

    if (room.hostId === userId) {
      // Host left - delete room
      this.rooms.delete(roomId);
      this.userToRoom.delete(userId);
      if (room.guestId) {
        this.userToRoom.delete(room.guestId);
      }
      console.log(`[RoomManager] Room ${roomId} deleted (host left)`);
    } else if (room.guestId === userId) {
      // Guest left - clear guest
      room.guestId = null;
      this.userToRoom.delete(userId);
      console.log(`[RoomManager] Guest left room ${roomId}`);
    }

    return roomId;
  }

  private generateRoomId(): string {
    // Generate 6-character alphanumeric ID
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }

    // Ensure uniqueness
    if (this.rooms.has(result)) {
      return this.generateRoomId();
    }

    return result;
  }

  getRoomCount(): number {
    return this.rooms.size;
  }

  getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }
}
