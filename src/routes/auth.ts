import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { jwtAuth, requireRole } from '../middleware/jwtAuth';

const router = Router();

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key);
}

function signToken(payload: { userId: string; email: string; role: string }): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET must be set');
  }
  return jwt.sign(payload, secret, { expiresIn: '24h' });
}

/**
 * POST /api/auth/register
 * 유저 생성 (admin이 role 지정 가능)
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, role: requestedRole } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    // admin role 지정은 JWT + admin role 필요
    let role = 'host';
    if (requestedRole && requestedRole !== 'host') {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(403).json({ error: 'Admin authentication required to set role' });
        return;
      }
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        res.status(500).json({ error: 'Server configuration error' });
        return;
      }
      try {
        const payload = jwt.verify(authHeader.slice(7), secret) as { role: string };
        if (payload.role !== 'admin') {
          res.status(403).json({ error: 'Admin role required' });
          return;
        }
        role = requestedRole;
      } catch {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
    }

    const supabase = getSupabase();

    // Check duplicate email
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { data: user, error } = await supabase
      .from('users')
      .insert({ email, password_hash: passwordHash, role })
      .select('id, email, role')
      .single();

    if (error) {
      console.error('[Auth] Register error:', error);
      res.status(500).json({ error: 'Failed to create account' });
      return;
    }

    const token = signToken({ userId: user.id, email: user.email, role: user.role });

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('[Auth] Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const supabase = getSupabase();

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, password_hash, role')
      .eq('email', email)
      .single();

    if (error || !user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = signToken({ userId: user.id, email: user.email, role: user.role });

    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/auth/me
 */
router.get('/me', jwtAuth, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

/**
 * GET /api/auth/users
 * 유저 목록 (admin only)
 */
router.get('/users', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data: users, error, count } = await supabase
      .from('users')
      .select('id, email, role, created_at', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Auth] Get users error:', error);
      res.status(500).json({ error: 'Failed to fetch users' });
      return;
    }

    res.json({ users: users || [], total: count || 0 });
  } catch (err) {
    console.error('[Auth] Get users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/auth/users/:id
 * 유저 삭제 (admin only, 본인 삭제 불가)
 */
router.delete('/users/:id', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const targetId = req.params.id;

    if (req.user?.userId === targetId) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    const supabase = getSupabase();
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', targetId);

    if (error) {
      console.error('[Auth] Delete user error:', error);
      res.status(500).json({ error: 'Failed to delete user' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Auth] Delete user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/auth/stats
 * 대시보드 통계 (JWT 필요)
 */
router.get('/stats', jwtAuth, async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();

    // 상태별 film count
    const [activeRes, expiredRes, deletedRes] = await Promise.all([
      supabase.from('films').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('films').select('id', { count: 'exact', head: true }).eq('status', 'expired'),
      supabase.from('films').select('id', { count: 'exact', head: true }).eq('status', 'deleted'),
    ]);

    // 오늘 생성된 film count
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { count: todayCount } = await supabase
      .from('films')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', todayStart.toISOString())
      .neq('status', 'deleted');

    // 최근 5개 film
    const { data: recentFilms } = await supabase
      .from('films')
      .select('id, status, photo_url, video_url, created_at, expires_at')
      .neq('status', 'deleted')
      .order('created_at', { ascending: false })
      .limit(5);

    res.json({
      active: activeRes.count || 0,
      expired: expiredRes.count || 0,
      deleted: deletedRes.count || 0,
      today: todayCount || 0,
      recentFilms: (recentFilms || []).map((f) => ({
        id: f.id,
        status: f.status,
        photoUrl: f.photo_url,
        videoUrl: f.video_url,
        createdAt: f.created_at,
        expiresAt: f.expires_at,
      })),
    });
  } catch (err) {
    console.error('[Auth] Stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as authRouter };
