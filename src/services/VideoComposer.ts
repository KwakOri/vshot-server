import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs/promises';
import ffmpegStatic from 'ffmpeg-static';
import { v4 as uuidv4 } from 'uuid';

/**
 * Frame layout position for video placement (pixel-based)
 */
export interface FramePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

/**
 * Frame slot position as ratios (0-1)
 * Resolution-independent layout definition
 */
export interface FrameSlotRatio {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

/**
 * Frame layout configuration
 */
export interface FrameLayout {
  id: string;
  label: string;
  slotCount: number;
  positions: FramePosition[];
  canvasWidth: number;
  canvasHeight: number;
  backgroundColor?: string;
  frameSrc?: string;
}

/**
 * Ratio-based layout definition
 */
export interface FrameLayoutDefinition {
  id: string;
  label: string;
  slotCount: number;
  positionRatios: FrameSlotRatio[];
  backgroundColor?: string;
  frameSrc?: string;
}

/**
 * Video composition options
 */
export interface ComposeOptions {
  layout: FrameLayout;
  outputFormat?: 'mp4' | 'webm';
  frameRate?: number;
  quality?: number; // CRF value (18-28, lower = better quality)
}

/**
 * Composition progress callback
 */
export interface ComposeProgress {
  percent: number;
  currentTime: string;
  stage: 'preparing' | 'composing' | 'finalizing';
}

/**
 * Composition result
 */
export interface ComposeResult {
  outputPath: string;
  outputUrl: string;
  duration: number;
  fileSize: number;
  timing: {
    totalMs: number;
    prepareMs: number;
    composeMs: number;
  };
}

/**
 * Video composition resolution (matches client RESOLUTION.VIDEO_WIDTH/HEIGHT)
 */
const VIDEO_WIDTH = 720;
const VIDEO_HEIGHT = 1080;

/**
 * Layout ratio constants (matches client FRAME_LAYOUT_RATIO)
 */
const LAYOUT_RATIO = {
  gap: 0.0125,    // 1.25% of width
  padding: 0.025, // 2.5% of width
};

/**
 * Round down to nearest even number (required for yuv420p)
 */
function toEven(n: number): number {
  const rounded = Math.round(n);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/**
 * Convert ratio-based positions to pixel-based positions
 */
function resolvePositions(
  ratios: FrameSlotRatio[],
  width: number,
  height: number
): FramePosition[] {
  return ratios.map((ratio) => ({
    x: Math.round(ratio.x * width),
    y: Math.round(ratio.y * height),
    width: toEven(ratio.width * width),
    height: toEven(ratio.height * height),
    zIndex: ratio.zIndex,
  }));
}

/**
 * Calculate grid positions as ratios
 */
function calculateGridRatios(
  cols: number,
  rows: number,
  padding: number = LAYOUT_RATIO.padding,
  gap: number = LAYOUT_RATIO.gap
): FrameSlotRatio[] {
  const availableWidth = 1 - (padding * 2) - (gap * (cols - 1));
  const availableHeight = 1 - (padding * 2) - (gap * (rows - 1));
  const cellWidth = availableWidth / cols;
  const cellHeight = availableHeight / rows;

  const positions: FrameSlotRatio[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      positions.push({
        x: padding + col * (cellWidth + gap),
        y: padding + row * (cellHeight + gap),
        width: cellWidth,
        height: cellHeight,
        zIndex: row * cols + col,
      });
    }
  }

  return positions;
}

/**
 * Single slot that fills the canvas with padding
 */
function calculateSingleSlotRatio(
  padding: number = LAYOUT_RATIO.padding
): FrameSlotRatio[] {
  return [{
    x: padding,
    y: padding,
    width: 1 - (padding * 2),
    height: 1 - (padding * 2),
    zIndex: 0,
  }];
}

/**
 * Resolve a layout definition to pixel-based FrameLayout
 */
function resolveLayout(
  definition: FrameLayoutDefinition,
  width: number = VIDEO_WIDTH,
  height: number = VIDEO_HEIGHT
): FrameLayout {
  return {
    id: definition.id,
    label: definition.label,
    slotCount: definition.slotCount,
    positions: resolvePositions(definition.positionRatios, width, height),
    canvasWidth: width,
    canvasHeight: height,
    backgroundColor: definition.backgroundColor,
    frameSrc: definition.frameSrc,
  };
}

/**
 * Get frame asset path - uses process.cwd() for consistent path resolution
 * Works in both development (tsx) and production (node dist/) modes
 */
function getFrameAssetPath(filename: string): string {
  return path.join(process.cwd(), 'assets', 'frames', filename);
}

/**
 * Ratio-based layout definitions
 */
const LAYOUT_DEFINITIONS: FrameLayoutDefinition[] = [
  {
    id: '4cut-grid',
    label: '인생네컷 (2x2)',
    slotCount: 4,
    positionRatios: calculateGridRatios(2, 2),
    backgroundColor: '#1a1a2e',
    frameSrc: getFrameAssetPath('4cut-grid.png'),
  },
  {
    id: '4cut-quoka',
    label: '쿼카 4컷',
    slotCount: 4,
    // Quoka frame positions as ratios (original: 3000x4500)
    positionRatios: [
      { x: 153 / 3000, y: 1068 / 4500, width: 1280 / 3000, height: 1520 / 4500, zIndex: 0 },
      { x: 153 / 3000, y: 2673 / 4500, width: 1280 / 3000, height: 1520 / 4500, zIndex: 1 },
      { x: 1587 / 3000, y: 307 / 4500, width: 1280 / 3000, height: 1520 / 4500, zIndex: 2 },
      { x: 1587 / 3000, y: 1912 / 4500, width: 1280 / 3000, height: 1520 / 4500, zIndex: 3 },
    ],
    backgroundColor: '#1a1a2e',
    frameSrc: getFrameAssetPath('quoka.png'),
  },
];

/**
 * Predefined frame layouts for video composition (720×1080)
 * Resolved from ratio-based definitions
 */
export const FRAME_LAYOUTS: Record<string, FrameLayout> = Object.fromEntries(
  LAYOUT_DEFINITIONS.map(def => [def.id, resolveLayout(def)])
);

/**
 * VideoComposer - Server-side video composition using FFmpeg
 *
 * Composes multiple video segments into a single frame layout
 */
export class VideoComposer {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;

    // Set FFmpeg binary path from ffmpeg-static
    if (ffmpegStatic) {
      ffmpeg.setFfmpegPath(ffmpegStatic);
      console.log('[VideoComposer] FFmpeg path set to:', ffmpegStatic);
    } else {
      console.warn('[VideoComposer] ffmpeg-static path not found, using system FFmpeg');
    }
  }

  /**
   * Get layout by ID
   */
  getLayout(layoutId: string): FrameLayout | undefined {
    return FRAME_LAYOUTS[layoutId];
  }

  /**
   * Get layout by ID with custom resolution
   */
  getLayoutForResolution(layoutId: string, width: number, height: number): FrameLayout | undefined {
    const definition = LAYOUT_DEFINITIONS.find(def => def.id === layoutId);
    if (!definition) return undefined;
    return resolveLayout(definition, width, height);
  }

  /**
   * Compose multiple videos into a frame layout
   *
   * @param videoPaths Array of input video file paths (in slot order)
   * @param options Composition options
   * @param onProgress Progress callback
   * @returns Composition result with output path and timing info
   */
  async compose(
    videoPaths: string[],
    options: ComposeOptions,
    onProgress?: (progress: ComposeProgress) => void
  ): Promise<ComposeResult> {
    const startTime = Date.now();
    const { layout, outputFormat = 'mp4', frameRate = 24, quality = 23 } = options;

    // Validate inputs
    if (videoPaths.length !== layout.slotCount) {
      throw new Error(`Expected ${layout.slotCount} videos, got ${videoPaths.length}`);
    }

    // Verify all input files exist
    for (const videoPath of videoPaths) {
      try {
        await fs.access(videoPath);
      } catch {
        throw new Error(`Input video not found: ${videoPath}`);
      }
    }

    // Ensure output directory exists
    await fs.mkdir(this.outputDir, { recursive: true });

    const prepareTime = Date.now();
    onProgress?.({ percent: 5, currentTime: '00:00:00', stage: 'preparing' });

    // Generate output filename
    const outputFilename = `composed-${uuidv4()}-${Date.now()}.${outputFormat}`;
    const outputPath = path.join(this.outputDir, outputFilename);

    // Check if frame overlay exists
    let frameOverlayPath: string | undefined;
    if (layout.frameSrc) {
      try {
        await fs.access(layout.frameSrc);
        frameOverlayPath = layout.frameSrc;
        console.log('[VideoComposer] Frame overlay found:', frameOverlayPath);
      } catch {
        console.warn('[VideoComposer] Frame overlay not found:', layout.frameSrc);
      }
    }

    console.log('[VideoComposer] Starting composition...');
    console.log('[VideoComposer] Layout:', layout.id, `(${layout.slotCount} slots)`);
    console.log('[VideoComposer] Canvas:', `${layout.canvasWidth}x${layout.canvasHeight}`);
    console.log('[VideoComposer] Inputs:', videoPaths);
    console.log('[VideoComposer] Frame overlay:', frameOverlayPath || 'none');
    console.log('[VideoComposer] Output:', outputPath);

    // Build FFmpeg filter complex
    const filterComplex = this.buildFilterComplex(layout, videoPaths.length, !!frameOverlayPath);

    const composeStartTime = Date.now();
    onProgress?.({ percent: 10, currentTime: '00:00:00', stage: 'composing' });

    return new Promise((resolve, reject) => {
      let command = ffmpeg();

      // Add all input videos
      for (const videoPath of videoPaths) {
        command = command.input(videoPath);
      }

      // Add frame overlay image as last input (if exists)
      if (frameOverlayPath) {
        command = command.input(frameOverlayPath);
      }

      command
        .complexFilter(filterComplex)
        .outputOptions([
          '-map [outv]',
          `-r ${frameRate}`,
          `-crf ${quality}`,
          '-preset fast',
          '-movflags +faststart',
        ])
        .videoCodec('libx264')
        .format(outputFormat === 'mp4' ? 'mp4' : 'webm')
        .on('progress', (progress) => {
          const percent = Math.min(90, 10 + (progress.percent || 0) * 0.8);
          onProgress?.({
            percent: Math.round(percent),
            currentTime: progress.timemark || '00:00:00',
            stage: 'composing',
          });
        })
        .on('end', async () => {
          const endTime = Date.now();
          onProgress?.({ percent: 100, currentTime: '00:00:00', stage: 'finalizing' });

          try {
            const stats = await fs.stat(outputPath);
            const metadata = await this.getVideoMetadata(outputPath);

            const result: ComposeResult = {
              outputPath,
              outputUrl: `/uploads/test/${outputFilename}`,
              duration: metadata.format?.duration || 0,
              fileSize: stats.size,
              timing: {
                totalMs: endTime - startTime,
                prepareMs: composeStartTime - prepareTime,
                composeMs: endTime - composeStartTime,
              },
            };

            console.log('[VideoComposer] Composition complete:', {
              outputPath,
              duration: `${result.duration.toFixed(2)}s`,
              fileSize: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
              totalTime: `${result.timing.totalMs}ms`,
            });

            resolve(result);
          } catch (error) {
            reject(error);
          }
        })
        .on('start', (cmd) => {
          console.log('[VideoComposer] FFmpeg command:', cmd);
        })
        .on('error', (err, stdout, stderr) => {
          console.error('[VideoComposer] Composition failed:', err.message);
          if (stderr) {
            console.error('[VideoComposer] FFmpeg stderr:', stderr);
          }
          reject(new Error(`FFmpeg composition failed: ${err.message}`));
        })
        .save(outputPath);
    });
  }

  /**
   * Build FFmpeg filter complex string for the layout
   * @param layout Frame layout configuration
   * @param inputCount Number of video inputs
   * @param hasFrameOverlay Whether a frame overlay image is included as the last input
   */
  private buildFilterComplex(layout: FrameLayout, inputCount: number, hasFrameOverlay: boolean = false): string {
    const { canvasWidth, canvasHeight, positions, backgroundColor = '#1a1a2e' } = layout;

    const filters: string[] = [];

    // Create base canvas with background color
    filters.push(
      `color=c=${backgroundColor}:s=${canvasWidth}x${canvasHeight}:d=999[base]`
    );

    // Scale and position each input video
    for (let i = 0; i < inputCount; i++) {
      const pos = positions[i];

      // Scale input to fit position (force_divisible_by=2 prevents yuv420p rounding issues with pad)
      filters.push(
        `[${i}:v]scale=${pos.width}:${pos.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${pos.width}:${pos.height}:(ow-iw)/2:(oh-ih)/2:color=${backgroundColor}[v${i}]`
      );
    }

    // Overlay each scaled video onto the base canvas
    let currentBase = 'base';
    for (let i = 0; i < inputCount; i++) {
      const pos = positions[i];
      // If this is the last video and we have a frame overlay, output to 'preframe' instead of 'outv'
      const isLastVideo = i === inputCount - 1;
      const outputLabel = isLastVideo ? (hasFrameOverlay ? 'preframe' : 'outv') : `tmp${i}`;

      filters.push(
        `[${currentBase}][v${i}]overlay=${pos.x}:${pos.y}:shortest=1[${outputLabel}]`
      );

      currentBase = outputLabel;
    }

    // Add frame overlay on top (if exists)
    if (hasFrameOverlay) {
      const frameInputIndex = inputCount; // Frame image is the last input

      // Scale frame image to canvas size and overlay on top
      // eof_action=repeat: keep showing the last frame of the image (static image stays visible)
      filters.push(
        `[${frameInputIndex}:v]scale=${canvasWidth}:${canvasHeight}[frame]`
      );
      filters.push(
        `[preframe][frame]overlay=0:0:eof_action=repeat:shortest=0[outv]`
      );
    }

    return filters.join(';');
  }

  /**
   * Get video metadata using ffprobe
   */
  private async getVideoMetadata(filePath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(err);
        } else {
          resolve(metadata);
        }
      });
    });
  }

  /**
   * Clean up temporary files
   */
  async cleanup(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      try {
        await fs.unlink(filePath);
        console.log('[VideoComposer] Deleted temp file:', filePath);
      } catch (error) {
        console.error('[VideoComposer] Failed to delete temp file:', filePath, error);
      }
    }
  }
}
