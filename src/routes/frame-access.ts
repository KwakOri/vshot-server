import { Router, Request, Response } from 'express';
import { jwtAuth, requireRole } from '../middleware/jwtAuth';
import { getSupabase } from '../services/supabase';

const router = Router();

/**
 * GET /api/frame-access/:frameId
 * 프레임의 접근 권한 목록
 */
router.get('/:frameId', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { frameId } = req.params;

    // 유저 접근 권한 (유저 정보 포함)
    const { data: userAccess, error: userErr } = await supabase
      .from('frame_access')
      .select(`
        id,
        frame_id,
        user_id,
        group_id,
        created_at,
        users:user_id (id, email, role)
      `)
      .eq('frame_id', frameId)
      .not('user_id', 'is', null);

    // 그룹 접근 권한 (그룹 정보 포함)
    const { data: groupAccess, error: groupErr } = await supabase
      .from('frame_access')
      .select(`
        id,
        frame_id,
        user_id,
        group_id,
        created_at,
        groups:group_id (id, name)
      `)
      .eq('frame_id', frameId)
      .not('group_id', 'is', null);

    if (userErr || groupErr) {
      res.status(500).json({ error: 'Failed to fetch access list' });
      return;
    }

    const access = [
      ...(userAccess || []).map((a: any) => ({
        id: a.id,
        frameId: a.frame_id,
        type: 'user' as const,
        userId: a.user_id,
        userEmail: a.users?.email,
        userRole: a.users?.role,
        groupId: null,
        groupName: null,
        createdAt: a.created_at,
      })),
      ...(groupAccess || []).map((a: any) => ({
        id: a.id,
        frameId: a.frame_id,
        type: 'group' as const,
        userId: null,
        userEmail: null,
        userRole: null,
        groupId: a.group_id,
        groupName: a.groups?.name,
        createdAt: a.created_at,
      })),
    ];

    res.json({ access });
  } catch (err) {
    console.error('[FrameAccess] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/frame-access
 * 접근 권한 추가
 */
router.post('/', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { frameId, userId, groupId } = req.body;

    if (!frameId) {
      res.status(400).json({ error: 'frameId is required' });
      return;
    }

    if (!userId && !groupId) {
      res.status(400).json({ error: 'Either userId or groupId is required' });
      return;
    }

    if (userId && groupId) {
      res.status(400).json({ error: 'Provide either userId or groupId, not both' });
      return;
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('frame_access')
      .insert({
        frame_id: frameId,
        user_id: userId || null,
        group_id: groupId || null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: 'Access already granted' });
        return;
      }
      console.error('[FrameAccess] Create error:', error);
      res.status(500).json({ error: 'Failed to add access' });
      return;
    }

    res.status(201).json({ access: data });
  } catch (err) {
    console.error('[FrameAccess] Create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/frame-access/:id
 * 접근 권한 제거
 */
router.delete('/:id', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('frame_access')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to remove access' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[FrameAccess] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as frameAccessRouter };
