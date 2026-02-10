import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { nanoid } from 'nanoid';
import { uploadToR2, deleteFromR2, generateObjectKey, getPublicFileUrl } from '../services/r2';
import { getSupabase } from '../services/supabase';

const router = Router();
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

/**
 * POST /api/festa/upload
 *
 * Multipart file upload → R2 + Supabase files record
 */
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  let fileId: string | null = null;
  let objectKey: string | null = null;

  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, error: 'No file provided' });
      return;
    }

    const ownerId = req.body.ownerId || null;
    fileId = uuidv4();
    objectKey = generateObjectKey(fileId);
    const supabase = getSupabase();

    // Step 1: Create DB record (pending)
    const { error: insertError } = await supabase
      .from('files')
      .insert({
        id: fileId,
        bucket: process.env.R2_BUCKET_NAME || '',
        object_key: objectKey,
        original_filename: file.originalname,
        content_type: file.mimetype || 'application/octet-stream',
        size: file.size,
        owner_id: ownerId,
        status: 'pending',
      });

    if (insertError) {
      console.error('[Festa] DB insert error:', insertError);
      res.status(500).json({ success: false, error: 'Failed to create file record' });
      return;
    }

    // Step 2: Upload to R2
    try {
      await uploadToR2(objectKey, file.buffer, file.mimetype || 'application/octet-stream');
    } catch (uploadError) {
      console.error('[Festa] R2 upload error:', uploadError);
      await supabase.from('files').delete().eq('id', fileId);
      res.status(500).json({ success: false, error: 'Failed to upload file to storage' });
      return;
    }

    // Step 3: Update status to uploaded
    const { error: updateError } = await supabase
      .from('files')
      .update({ status: 'uploaded', uploaded_at: new Date().toISOString() })
      .eq('id', fileId);

    if (updateError) {
      console.error('[Festa] DB update error:', updateError);
      try {
        await deleteFromR2(objectKey);
      } catch { /* ignore */ }
      await supabase.from('files').delete().eq('id', fileId);
      res.status(500).json({ success: false, error: 'Failed to finalize upload' });
      return;
    }

    const fileUrl = getPublicFileUrl(objectKey);

    res.json({
      success: true,
      file: {
        id: fileId,
        url: fileUrl,
        originalFilename: file.originalname,
        contentType: file.mimetype || 'application/octet-stream',
        size: file.size,
      },
    });
  } catch (error) {
    console.error('[Festa] Upload error:', error);
    if (fileId) {
      try {
        const supabase = getSupabase();
        await supabase.from('files').delete().eq('id', fileId);
        if (objectKey) await deleteFromR2(objectKey);
      } catch { /* ignore */ }
    }
    res.status(500).json({ success: false, error: 'An unexpected error occurred' });
  }
});

/**
 * POST /api/festa/film
 *
 * Create film record in Supabase
 */
router.post('/film', async (req: Request, res: Response) => {
  try {
    const { id: clientId, roomId, sessionId, photoFileId, videoFileId } = req.body;

    if (!roomId) {
      res.status(400).json({ success: false, error: 'roomId is required' });
      return;
    }

    const supabase = getSupabase();
    let film: any = null;
    let insertError: any = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const id = (attempt === 0 && clientId) ? clientId : nanoid(8);
      const { data, error } = await supabase
        .from('films')
        .insert({
          id,
          room_id: roomId,
          session_id: sessionId || null,
          photo_file_id: photoFileId || null,
          video_file_id: videoFileId || null,
        })
        .select()
        .single();

      if (!error) {
        film = data;
        break;
      }

      if (error.code === '23505' && attempt === 0) {
        console.warn('[Festa] nanoid collision, retrying...');
        continue;
      }

      insertError = error;
      break;
    }

    if (insertError || !film) {
      console.error('[Festa] Film insert error:', insertError);
      res.status(500).json({ success: false, error: 'Failed to create film record' });
      return;
    }

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const qrCodeUrl = `${appUrl}/download/${film.id}`;

    await supabase
      .from('films')
      .update({ qr_code_url: qrCodeUrl })
      .eq('id', film.id);

    res.json({
      success: true,
      film: {
        id: film.id,
        roomId: film.room_id,
        sessionId: film.session_id,
        photoUrl: null,
        videoUrl: null,
        qrCodeUrl,
        createdAt: film.created_at,
        expiresAt: film.expires_at,
        status: film.status,
      },
    });
  } catch (error) {
    console.error('[Festa] Film creation error:', error);
    res.status(500).json({ success: false, error: 'An unexpected error occurred' });
  }
});

export { router as festaRouter };
