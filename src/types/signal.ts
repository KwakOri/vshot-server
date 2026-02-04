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
  | { type: 'chromakey-settings'; roomId: string; settings: ChromaKeySettings }
  | { type: 'session-settings'; roomId: string; settings: SessionSettings }
  | { type: 'video-frame-request'; roomId: string; userId: string; selectedPhotos: number[] }
  | { type: 'host-display-options'; roomId: string; options: DisplayOptions }
  | { type: 'guest-display-options'; roomId: string; options: DisplayOptions }
  | { type: 'aspect-ratio-settings'; roomId: string; settings: AspectRatioSettings }
  | { type: 'frame-layout-settings'; roomId: string; settings: FrameLayoutSettings }
  | { type: 'segment-uploaded'; roomId: string; photoNumber: number; filename: string; userId: string }
  | { type: 'all-segments-uploaded'; roomId: string; segmentCount: number }
  | { type: 'session-restart'; roomId: string; userId: string };

export interface DisplayOptions {
  flipHorizontal: boolean;
}

export interface ChromaKeySettings {
  enabled: boolean;
  color: string;
  similarity: number;
  smoothness: number;
}

export interface SessionSettings {
  recordingDuration: number; // seconds
  captureInterval: number; // seconds
}

export type AspectRatio = '16:9' | '4:3' | '3:4' | '9:16' | '1:1';

export interface AspectRatioSettings {
  ratio: AspectRatio;
  width: number;
  height: number;
}

export interface FrameLayoutSettings {
  layoutId: string;
  slotCount: number;
  totalPhotos: number;
  selectablePhotos: number;
}

export interface UploadedSegment {
  photoNumber: number;
  filename: string;
  filePath: string;
  fileSize: number;
  uploadedAt: Date;
  userId: string;
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
  sessionSettings?: SessionSettings;
  aspectRatioSettings?: AspectRatioSettings;
  frameLayoutSettings?: FrameLayoutSettings;
  deletionTimerId?: NodeJS.Timeout; // Timer for delayed room deletion
  uploadedSegments: UploadedSegment[]; // Video segments uploaded for composition
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
