import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';

export type AspectRatio = '16:9' | '4:3' | '3:4' | '9:16' | '1:1';

export const ASPECT_RATIOS: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '4:3': { width: 1440, height: 1080 },
  '3:4': { width: 1080, height: 1440 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};

export interface MergeOptions {
  layout: 'overlap' | 'side-by-side' | 'custom';
  aspectRatio?: AspectRatio;
  outputWidth?: number;
  outputHeight?: number;
}

export class ImageMerger {
  private uploadDir: string;

  constructor(uploadDir: string) {
    this.uploadDir = uploadDir;
  }

  async ensureUploadDir(): Promise<void> {
    try {
      await fs.access(this.uploadDir);
    } catch {
      await fs.mkdir(this.uploadDir, { recursive: true });
      console.log(`[ImageMerger] Created upload directory: ${this.uploadDir}`);
    }
  }

  async mergeImages(
    guestImagePath: string,
    hostImagePath: string,
    outputPath: string,
    options: MergeOptions = { layout: 'overlap' }
  ): Promise<string> {
    const { layout, aspectRatio = '16:9' } = options;

    // Get dimensions from aspect ratio
    const dimensions = ASPECT_RATIOS[aspectRatio];
    const outputWidth = options.outputWidth || dimensions.width;
    const outputHeight = options.outputHeight || dimensions.height;

    try {
      // Log input image dimensions for debugging
      const guestMetadata = await sharp(guestImagePath).metadata();
      const hostMetadata = await sharp(hostImagePath).metadata();

      console.log(`[ImageMerger] Merging images:`, {
        guest: {
          path: guestImagePath,
          size: `${guestMetadata.width}x${guestMetadata.height}`,
          format: guestMetadata.format,
        },
        host: {
          path: hostImagePath,
          size: `${hostMetadata.width}x${hostMetadata.height}`,
          format: hostMetadata.format,
        },
        output: {
          size: `${outputWidth}x${outputHeight}`,
          layout,
        },
      });

      if (layout === 'overlap') {
        // Guest (실사) is background, Host (VTuber with alpha) is foreground
        await sharp(guestImagePath)
          .resize(outputWidth, outputHeight, { fit: 'cover' })
          .composite([
            {
              input: await sharp(hostImagePath)
                .resize(outputWidth, outputHeight, { fit: 'contain' })
                .toBuffer(),
              gravity: 'center'
            }
          ])
          .png()
          .toFile(outputPath);

        console.log(`[ImageMerger] ✅ Merged images (overlap) at ${outputWidth}x${outputHeight}: ${outputPath}`);
      } else if (layout === 'side-by-side') {
        // Place images side by side
        const halfWidth = Math.floor(outputWidth / 2);

        const guestBuffer = await sharp(guestImagePath)
          .resize(halfWidth, outputHeight, { fit: 'cover' })
          .toBuffer();

        const hostBuffer = await sharp(hostImagePath)
          .resize(halfWidth, outputHeight, { fit: 'cover' })
          .toBuffer();

        await sharp({
          create: {
            width: outputWidth,
            height: outputHeight,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 }
          }
        })
          .composite([
            { input: guestBuffer, left: 0, top: 0 },
            { input: hostBuffer, left: halfWidth, top: 0 }
          ])
          .png()
          .toFile(outputPath);

        console.log(`[ImageMerger] Merged images (side-by-side) at ${outputWidth}x${outputHeight}: ${outputPath}`);
      }

      return outputPath;
    } catch (error) {
      console.error('[ImageMerger] Error merging images:', error);
      throw new Error('Failed to merge images');
    }
  }

  async saveBase64Image(base64Data: string, filename: string): Promise<string> {
    await this.ensureUploadDir();

    // Remove data URL prefix if present
    const base64String = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64String, 'base64');

    const filePath = path.join(this.uploadDir, filename);
    await fs.writeFile(filePath, buffer);

    console.log(`[ImageMerger] Saved image: ${filePath}`);
    return filePath;
  }

  getPublicUrl(filename: string): string {
    return `/uploads/${filename}`;
  }

  getFilePath(filename: string): string {
    return path.join(this.uploadDir, filename);
  }
}
