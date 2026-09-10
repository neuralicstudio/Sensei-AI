import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseServer } from '@/lib/supabaseServer';
import { suspendMarketplaceUser } from '@/lib/user-suspend';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/user/suspend
 * Suspend a user account. Admin only.
 * - If user is agent: their jobs will show as "no longer available" and guides cannot bid.
 * - If user is guide: their tours are set to status 'banned'.
 * Returns counts so the admin UI can display the results.
 * Body: { userId: string | number }
 */
export async function POST(req: NextRequest) {
  try {
    const jar = await cookies();
    const adminId = jar.get('userId')?.value;
    const role = jar.get('role')?.value;

    if (role !== 'admin' || !adminId) {
      return NextResponse.json(
        { ok: false, error: 'Unauthorized. Admin access required.' },
        { status: 403 }
      );
    }

    const supabase = getSupabaseServer();
    const { data: admin } = await supabase
      .from('admin')
      .select('id')
      .eq('id', adminId)
      .eq('is_active', true)
      .single();

    if (!admin) {
      return NextResponse.json(
        { ok: false, error: 'Unauthorized. Admin access required.' },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const rawUserId = body?.userId;
    const userId =
      rawUserId !== undefined && rawUserId !== null && rawUserId !== ''
        ? String(rawUserId)
        : null;

    if (!userId) {
      return NextResponse.json(
        { ok: false, error: 'Valid userId is required.' },
        { status: 400 }
      );
    }

    const result = await suspendMarketplaceUser(supabase, userId);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: result.status }
      );
    }

    if (result.alreadySuspended) {
      return NextResponse.json(
        { ok: false, error: 'User is already suspended.' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: 'User suspended.',
      role: result.role,
      jobsNoLongerAvailable: result.jobsNoLongerAvailable,
      toursBanned: result.toursBanned,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unexpected error';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
