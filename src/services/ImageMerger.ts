import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { uploadToR2, isR2Configured, getPublicFileUrl, generateObjectKey } from './r2';

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
  constructor() {}

  /**
   * Save base64 image to R2
   * @returns R2 public URL
   */
  async saveBase64Image(base64Data: string): Promise<{ url: string; fileId: string }> {
    if (!isR2Configured()) {
      throw new Error('R2 storage is not configured');
    }

    const base64String = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64String, 'base64');
    const fileId = uuidv4();
    const objectKey = generateObjectKey(fileId);

    await uploadToR2(objectKey, buffer, 'image/png');

    const url = getPublicFileUrl(objectKey);
    console.log(`[ImageMerger] Saved image to R2: ${objectKey}`);
    return { url, fileId };
  }

  /**
   * Merge two images from buffers
   * @returns Merged image buffer
   */
  async mergeBuffers(
    guestBuffer: Buffer,
    hostBuffer: Buffer,
    options: MergeOptions = { layout: 'overlap' }
  ): Promise<Buffer> {
    const { layout, aspectRatio = '16:9' } = options;
    const dimensions = ASPECT_RATIOS[aspectRatio];
    const outputWidth = options.outputWidth || dimensions.width;
    const outputHeight = options.outputHeight || dimensions.height;

    const guestMetadata = await sharp(guestBuffer).metadata();
    const hostMetadata = await sharp(hostBuffer).metadata();

    console.log(`[ImageMerger] Merging images:`, {
      guest: { size: `${guestMetadata.width}x${guestMetadata.height}`, format: guestMetadata.format },
      host: { size: `${hostMetadata.width}x${hostMetadata.height}`, format: hostMetadata.format },
      output: { size: `${outputWidth}x${outputHeight}`, layout },
    });

    if (layout === 'overlap') {
      const hostResized = await sharp(hostBuffer)
        .resize(outputWidth, outputHeight, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();

      return sharp(guestBuffer)
        .resize(outputWidth, outputHeight, { fit: 'cover' })
        .composite([{ input: hostResized, gravity: 'center' }])
        .png()
        .toBuffer();
    } else if (layout === 'side-by-side') {
      const halfWidth = Math.floor(outputWidth / 2);

      const guestResized = await sharp(guestBuffer)
        .resize(halfWidth, outputHeight, { fit: 'cover' })
        .toBuffer();

      const hostResized = await sharp(hostBuffer)
        .resize(halfWidth, outputHeight, { fit: 'cover' })
        .toBuffer();

      return sharp({
        create: {
          width: outputWidth,
          height: outputHeight,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      })
        .composite([
          { input: guestResized, left: 0, top: 0 },
          { input: hostResized, left: halfWidth, top: 0 },
        ])
        .png()
        .toBuffer();
    }

    throw new Error(`Unsupported layout: ${layout}`);
  }

  /**
   * Merge two images and upload result to R2
   * @returns R2 public URL of merged image
   */
  async mergeAndUpload(
    guestBuffer: Buffer,
    hostBuffer: Buffer,
    options: MergeOptions = { layout: 'overlap' }
  ): Promise<{ url: string; fileId: string }> {
    const mergedBuffer = await this.mergeBuffers(guestBuffer, hostBuffer, options);
    const fileId = uuidv4();
    const objectKey = generateObjectKey(fileId);

    await uploadToR2(objectKey, mergedBuffer, 'image/png');
    const url = getPublicFileUrl(objectKey);

    console.log(`[ImageMerger] Merged image uploaded to R2: ${objectKey}`);
    return { url, fileId };
  }
}
