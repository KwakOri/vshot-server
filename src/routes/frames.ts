import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { jwtAuth, requireRole } from '../middleware/jwtAuth';
import { getSupabase } from '../services/supabase';
import { uploadToR2, deleteFromR2, isR2Configured, getPublicFileUrl } from '../services/r2';

const router = Router();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

function generateFrameObjectKey(frameId: string, type: 'frame' | 'thumbnail'): string {
  return `frames/${frameId}/${type}.png`;
}

/**
 * 파일을 R2에 업로드하고 files 테이블에 레코드 생성
 */
async function uploadFrameFile(
  file: Express.Multer.File,
  frameId: string,
  type: 'frame' | 'thumbnail'
): Promise<string> {
  const supabase = getSupabase();
  const fileId = uuidv4();
  const objectKey = generateFrameObjectKey(frameId, type);

  // files 테이블에 레코드 생성
  const { error: insertError } = await supabase.from('files').insert({
    id: fileId,
    bucket: process.env.R2_BUCKET_NAME || '',
    object_key: objectKey,
    original_filename: file.originalname,
    content_type: file.mimetype || 'image/png',
    size: file.size,
    status: 'pending',
  });

  if (insertError) throw new Error(`DB insert failed: ${insertError.message}`);

  // R2 업로드
  await uploadToR2(objectKey, file.buffer, file.mimetype || 'image/png');

  // 상태 업데이트
  await supabase.from('files').update({
    status: 'uploaded',
    uploaded_at: new Date().toISOString(),
  }).eq('id', fileId);

  return fileId;
}

/**
 * frame row에 이미지 URL 추가
 */
function enrichFrameWithUrls(frame: any): any {
  const result = { ...frame };
  if (frame.frame_file_id) {
    const objectKey = generateFrameObjectKey(frame.id, 'frame');
    try {
      result.frame_image_url = getPublicFileUrl(objectKey);
    } catch {
      result.frame_image_url = null;
    }
  } else {
    result.frame_image_url = null;
  }
  if (frame.thumbnail_file_id) {
    const objectKey = generateFrameObjectKey(frame.id, 'thumbnail');
    try {
      result.thumbnail_url = getPublicFileUrl(objectKey);
    } catch {
      result.thumbnail_url = null;
    }
  } else {
    result.thumbnail_url = null;
  }
  return result;
}

function toClientFrame(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    frameFileId: row.frame_file_id,
    thumbnailFileId: row.thumbnail_file_id,
    frameImageUrl: row.frame_image_url,
    thumbnailUrl: row.thumbnail_url,
    canvasWidth: row.canvas_width,
    canvasHeight: row.canvas_height,
    slotPositions: row.slot_positions,
    slotCount: row.slot_count,
    isPublic: row.is_public,
    category: row.category,
    tags: row.tags,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * GET /api/frames
 * 호스트용 - 접근 가능한 프레임 목록 (공용 + 권한 있는 비공용)
 */
router.get('/', jwtAuth, async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const userId = req.user!.userId;

    // 1. 공용 프레임
    const { data: publicFrames, error: pubErr } = await supabase
      .from('frames')
      .select('*')
      .eq('is_active', true)
      .eq('is_public', true)
      .order('sort_order');

    if (pubErr) {
      res.status(500).json({ error: 'Failed to fetch public frames' });
      return;
    }

    // 2. 비공용 프레임 - 유저 직접 접근 권한
    const { data: userAccess } = await supabase
      .from('frame_access')
      .select('frame_id')
      .eq('user_id', userId);

    // 3. 비공용 프레임 - 그룹을 통한 접근 권한
    const { data: userGroups } = await supabase
      .from('user_groups')
      .select('group_id')
      .eq('user_id', userId);

    let groupAccess: any[] = [];
    if (userGroups && userGroups.length > 0) {
      const groupIds = userGroups.map((g) => g.group_id);
      const { data } = await supabase
        .from('frame_access')
        .select('frame_id')
        .in('group_id', groupIds);
      groupAccess = data || [];
    }

    // 접근 가능한 비공용 프레임 ID 수집
    const accessibleFrameIds = new Set<string>();
    (userAccess || []).forEach((a) => accessibleFrameIds.add(a.frame_id));
    groupAccess.forEach((a) => accessibleFrameIds.add(a.frame_id));

    let privateFrames: any[] = [];
    if (accessibleFrameIds.size > 0) {
      const { data } = await supabase
        .from('frames')
        .select('*')
        .eq('is_active', true)
        .eq('is_public', false)
        .in('id', Array.from(accessibleFrameIds))
        .order('sort_order');
      privateFrames = data || [];
    }

    // admin은 모든 활성 프레임 접근 가능
    if (req.user!.role === 'admin') {
      const { data: allActive } = await supabase
        .from('frames')
        .select('*')
        .eq('is_active', true)
        .order('sort_order');

      const frames = (allActive || []).map(enrichFrameWithUrls).map(toClientFrame);
      res.json({ frames });
      return;
    }

    const allFrames = [...(publicFrames || []), ...privateFrames];
    // 중복 제거 및 정렬
    const uniqueMap = new Map<string, any>();
    allFrames.forEach((f) => uniqueMap.set(f.id, f));
    const frames = Array.from(uniqueMap.values())
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
      .map(enrichFrameWithUrls)
      .map(toClientFrame);

    res.json({ frames });
  } catch (err) {
    console.error('[Frames] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/frames/admin/all
 * 관리자용 - 모든 프레임 목록
 */
router.get('/admin/all', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('frames')
      .select('*')
      .order('sort_order');

    if (error) {
      res.status(500).json({ error: 'Failed to fetch frames' });
      return;
    }

    const frames = (data || []).map(enrichFrameWithUrls).map(toClientFrame);
    res.json({ frames });
  } catch (err) {
    console.error('[Frames] Admin list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/frames/:id
 * 단일 프레임 조회
 */
router.get('/:id', jwtAuth, async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('frames')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Frame not found' });
      return;
    }

    res.json({ frame: toClientFrame(enrichFrameWithUrls(data)) });
  } catch (err) {
    console.error('[Frames] Get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/frames
 * 프레임 생성 (이미지 업로드 + 메타데이터)
 */
router.post(
  '/',
  jwtAuth,
  requireRole('admin'),
  upload.fields([
    { name: 'frameImage', maxCount: 1 },
    { name: 'thumbnailImage', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    try {
      if (!isR2Configured()) {
        res.status(503).json({ error: 'Storage (R2) is not configured' });
        return;
      }

      const {
        name,
        description,
        canvasWidth,
        canvasHeight,
        slotPositions,
        slotCount,
        isPublic,
        category,
        tags,
        sortOrder,
      } = req.body;

      if (!name) {
        res.status(400).json({ error: 'Name is required' });
        return;
      }

      const supabase = getSupabase();
      const frameId = uuidv4();
      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

      let frameFileId: string | null = null;
      let thumbnailFileId: string | null = null;

      // 프레임 이미지 업로드
      if (files?.frameImage?.[0]) {
        frameFileId = await uploadFrameFile(files.frameImage[0], frameId, 'frame');
      }

      // 썸네일 이미지 업로드
      if (files?.thumbnailImage?.[0]) {
        thumbnailFileId = await uploadFrameFile(files.thumbnailImage[0], frameId, 'thumbnail');
      }

      const parsedSlotPositions = typeof slotPositions === 'string'
        ? JSON.parse(slotPositions)
        : slotPositions || [];

      const parsedTags = typeof tags === 'string' ? JSON.parse(tags) : tags || [];

      const { data, error } = await supabase
        .from('frames')
        .insert({
          id: frameId,
          name,
          description: description || null,
          frame_file_id: frameFileId,
          thumbnail_file_id: thumbnailFileId,
          canvas_width: parseInt(canvasWidth) || 1600,
          canvas_height: parseInt(canvasHeight) || 2400,
          slot_positions: parsedSlotPositions,
          slot_count: parseInt(slotCount) || 1,
          is_public: isPublic === 'true' || isPublic === true,
          category: category || null,
          tags: parsedTags,
          sort_order: parseInt(sortOrder) || 0,
        })
        .select()
        .single();

      if (error) {
        console.error('[Frames] Create error:', error);
        res.status(500).json({ error: 'Failed to create frame' });
        return;
      }

      res.status(201).json({ frame: toClientFrame(enrichFrameWithUrls(data)) });
    } catch (err) {
      console.error('[Frames] Create error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * PUT /api/frames/:id
 * 프레임 수정
 */
router.put(
  '/:id',
  jwtAuth,
  requireRole('admin'),
  upload.fields([
    { name: 'frameImage', maxCount: 1 },
    { name: 'thumbnailImage', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      const frameId = req.params.id;

      // 기존 프레임 확인
      const { data: existing, error: findErr } = await supabase
        .from('frames')
        .select('*')
        .eq('id', frameId)
        .single();

      if (findErr || !existing) {
        res.status(404).json({ error: 'Frame not found' });
        return;
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };

      // 텍스트 필드 업데이트
      if (req.body.name !== undefined) updates.name = req.body.name;
      if (req.body.description !== undefined) updates.description = req.body.description || null;
      if (req.body.canvasWidth !== undefined) updates.canvas_width = parseInt(req.body.canvasWidth);
      if (req.body.canvasHeight !== undefined) updates.canvas_height = parseInt(req.body.canvasHeight);
      if (req.body.slotCount !== undefined) updates.slot_count = parseInt(req.body.slotCount);
      if (req.body.isPublic !== undefined) updates.is_public = req.body.isPublic === 'true' || req.body.isPublic === true;
      if (req.body.category !== undefined) updates.category = req.body.category || null;
      if (req.body.sortOrder !== undefined) updates.sort_order = parseInt(req.body.sortOrder);

      if (req.body.slotPositions !== undefined) {
        updates.slot_positions = typeof req.body.slotPositions === 'string'
          ? JSON.parse(req.body.slotPositions)
          : req.body.slotPositions;
      }

      if (req.body.tags !== undefined) {
        updates.tags = typeof req.body.tags === 'string'
          ? JSON.parse(req.body.tags)
          : req.body.tags;
      }

      // 이미지 업데이트
      if (files?.frameImage?.[0]) {
        // 기존 프레임 이미지 삭제
        if (existing.frame_file_id) {
          try {
            await deleteFromR2(generateFrameObjectKey(frameId, 'frame'));
          } catch { /* ignore */ }
        }
        updates.frame_file_id = await uploadFrameFile(files.frameImage[0], frameId, 'frame');
      }

      if (files?.thumbnailImage?.[0]) {
        if (existing.thumbnail_file_id) {
          try {
            await deleteFromR2(generateFrameObjectKey(frameId, 'thumbnail'));
          } catch { /* ignore */ }
        }
        updates.thumbnail_file_id = await uploadFrameFile(files.thumbnailImage[0], frameId, 'thumbnail');
      }

      const { data, error } = await supabase
        .from('frames')
        .update(updates)
        .eq('id', frameId)
        .select()
        .single();

      if (error) {
        res.status(500).json({ error: 'Failed to update frame' });
        return;
      }

      res.json({ frame: toClientFrame(enrichFrameWithUrls(data)) });
    } catch (err) {
      console.error('[Frames] Update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * DELETE /api/frames/:id
 * 프레임 삭제
 */
router.delete('/:id', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const frameId = req.params.id;

    const { data: existing } = await supabase
      .from('frames')
      .select('frame_file_id, thumbnail_file_id')
      .eq('id', frameId)
      .single();

    if (!existing) {
      res.status(404).json({ error: 'Frame not found' });
      return;
    }

    // R2에서 이미지 삭제
    if (existing.frame_file_id) {
      try {
        await deleteFromR2(generateFrameObjectKey(frameId, 'frame'));
      } catch { /* ignore */ }
    }
    if (existing.thumbnail_file_id) {
      try {
        await deleteFromR2(generateFrameObjectKey(frameId, 'thumbnail'));
      } catch { /* ignore */ }
    }

    // DB에서 삭제 (cascade로 frame_access도 삭제됨)
    const { error } = await supabase.from('frames').delete().eq('id', frameId);

    if (error) {
      res.status(500).json({ error: 'Failed to delete frame' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Frames] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as framesRouter };
