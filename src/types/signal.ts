// WebRTC Signaling Message Types
export type SignalMessage =
  // Connection management
  | { type: 'join'; roomId: string; userId: string; role: 'host' | 'guest' }
  | { type: 'joined'; roomId: string; role: 'host' | 'guest'; userId: string; hostId?: string }
  | { type: 'peer-joined'; userId: string; role: 'host' | 'guest' }
  | { type: 'peer-left'; userId: string }
  | { type: 'leave'; roomId: string; userId: string }
  | { type: 'error'; message: string }
  // WebRTC signaling
  | { type: 'offer'; roomId: string; from: string; to: string; sdp: string }
  | { type: 'answer'; roomId: string; from: string; to: string; sdp: string }
  | { type: 'ice'; roomId: string; from: string; to: string; candidate: any }
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
  | { type: 'session-restart'; roomId: string; userId: string }
  | { type: 'next-guest'; roomId: string; userId: string }
  | { type: 'guest-photo-data'; roomId: string; photoNumber: number; imageData: string }
  | { type: 'photos-merged-client'; roomId: string; mergedPhotos: Array<{ photoNumber: number; imageData: string }> }
  | { type: 'video-composed-client'; roomId: string; videoUrl: string }
  // V3 Messages - Guest Management
  | { type: 'guest-left-v3'; roomId: string; guestId: string }
  | { type: 'guest-joined-v3'; roomId: string; guestId: string; hostSettings: HostSettings }
  | { type: 'waiting-for-guest-v3'; roomId: string }
  // V3 Messages - Single Capture Flow
  | { type: 'frame-selected-v3'; roomId: string; layoutId: string; layout: FrameLayoutSettings }
  | { type: 'start-capture-v3'; roomId: string }
  | { type: 'countdown-tick-v3'; roomId: string; count: number }
  | { type: 'capture-now-v3'; roomId: string }
  | { type: 'photo-uploaded-v3'; roomId: string; userId: string; role: 'host' | 'guest'; photoUrl: string }
  | { type: 'photos-merged-v3'; roomId: string; mergedPhotoUrl: string }
  | { type: 'session-complete-v3'; roomId: string; sessionId: string; frameResultUrl: string }
  // V3 Messages - Host Settings Sync
  | { type: 'host-settings-sync-v3'; roomId: string; settings: HostSettings };

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

// V3 Types
export interface HostSettings {
  chromaKey: ChromaKeySettings;
  selectedFrameLayoutId: string;
  recordingDuration: number;
  captureInterval: number;
}

export interface V3Session {
  sessionId: string;
  guestId: string;
  hostPhotoUrl: string | null;
  guestPhotoUrl: string | null;
  mergedPhotoUrl: string | null;
  frameResultUrl: string | null;
  status: 'in_progress' | 'completed';
  createdAt: Date;
  completedAt: Date | null;
}

export interface V3Room {
  roomId: string;
  hostId: string;
  currentGuestId: string | null;

  // Host settings (persisted across guests)
  hostSettings: HostSettings;

  // Completed sessions
  completedSessions: V3Session[];

  createdAt: Date;
  lastActivityAt: Date;
}
