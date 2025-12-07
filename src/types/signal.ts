// WebRTC Signaling Message Types
export type SignalMessage =
  | { type: 'join'; roomId: string; userId: string; role: 'host' | 'guest' }
  | { type: 'offer'; roomId: string; from: string; to: string; sdp: string }
  | { type: 'answer'; roomId: string; from: string; to: string; sdp: string }
  | { type: 'ice'; roomId: string; from: string; to: string; candidate: any }
  | { type: 'leave'; roomId: string; userId: string }
  | { type: 'photo-session-start'; roomId: string }
  | { type: 'countdown-tick'; roomId: string; count: number; photoNumber: number }
  | { type: 'capture-now'; roomId: string; photoNumber: number }
  | { type: 'capture-request'; roomId: string; photoNumber: number }
  | { type: 'capture-uploaded'; roomId: string; userId: string; url: string; photoNumber: number }
  | { type: 'capture-complete'; roomId: string; imageUrl: string; photoNumber: number }
  | { type: 'photos-merged'; roomId: string; photos: Array<{ photoNumber: number; mergedImageUrl: string }> }
  | { type: 'photo-select'; roomId: string; userId: string; selectedIndices: number[] }
  | { type: 'photo-select-sync'; roomId: string; userId: string; selectedIndices: number[] }
  | { type: 'chromakey-settings'; roomId: string; settings: ChromaKeySettings };

export interface ChromaKeySettings {
  enabled: boolean;
  color: string;
  similarity: number;
  smoothness: number;
}

export interface Room {
  id: string;
  hostId: string;
  guestId: string | null;
  createdAt: Date;
  capturedPhotos: CapturedPhoto[];
  selectedPhotos: {
    host: number[];
    guest: number[];
  };
}

export interface CapturedPhoto {
  photoNumber: number;
  hostImageUrl: string | null;
  guestImageUrl: string | null;
  mergedImageUrl: string | null;
  timestamp: Date;
}

export interface RoomStatus {
  roomId: string;
  hostConnected: boolean;
  guestConnected: boolean;
  totalPhotos: number;
  selectedCount: {
    host: number;
    guest: number;
  };
}
