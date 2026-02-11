import { Router, Request, Response } from 'express';
import { jwtAuth, requireRole } from '../middleware/jwtAuth';
import { getSupabase } from '../services/supabase';

const router = Router();

/**
 * GET /api/groups
 * 그룹 목록
 */
router.get('/', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('groups')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch groups' });
      return;
    }

    res.json({ groups: data || [] });
  } catch (err) {
    console.error('[Groups] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/groups
 * 그룹 생성
 */
router.post('/', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('groups')
      .insert({ name, description: description || null })
      .select()
      .single();

    if (error) {
      console.error('[Groups] Create error:', error);
      res.status(500).json({ error: 'Failed to create group' });
      return;
    }

    res.status(201).json({ group: data });
  } catch (err) {
    console.error('[Groups] Create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/groups/:id
 * 그룹 수정
 */
router.put('/:id', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    const supabase = getSupabase();

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description || null;

    const { data, error } = await supabase
      .from('groups')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to update group' });
      return;
    }

    if (!data) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    res.json({ group: data });
  } catch (err) {
    console.error('[Groups] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/groups/:id
 * 그룹 삭제
 */
router.delete('/:id', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from('groups').delete().eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to delete group' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Groups] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/groups/:id/members
 * 그룹 멤버 목록
 */
router.get('/:id/members', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('user_groups')
      .select(`
        user_id,
        created_at,
        users:user_id (id, email, role)
      `)
      .eq('group_id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to fetch members' });
      return;
    }

    const members = (data || []).map((m: any) => ({
      userId: m.user_id,
      email: m.users?.email,
      role: m.users?.role,
      addedAt: m.created_at,
    }));

    res.json({ members });
  } catch (err) {
    console.error('[Groups] Members error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/groups/:id/members
 * 멤버 추가
 */
router.post('/:id/members', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    const supabase = getSupabase();
    const { error } = await supabase
      .from('user_groups')
      .insert({ user_id: userId, group_id: req.params.id });

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: 'User already in group' });
        return;
      }
      res.status(500).json({ error: 'Failed to add member' });
      return;
    }

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('[Groups] Add member error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/groups/:id/members/:userId
 * 멤버 제거
 */
router.delete('/:id/members/:userId', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('user_groups')
      .delete()
      .eq('group_id', req.params.id)
      .eq('user_id', req.params.userId);

    if (error) {
      res.status(500).json({ error: 'Failed to remove member' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Groups] Remove member error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as groupsRouter };
