import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseServer } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

/** Returns the current session's userId and profileId. Used by client-side flows
 *  that call external services directly (e.g. Sensei AI) and need both IDs. */
export async function GET() {
  const jar = await cookies();
  const userId = jar.get('userId')?.value;
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  const supabase = getSupabaseServer();
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: 'Database error' }, { status: 500 });
  }
  if (!profile?.id) {
    return NextResponse.json(
      { ok: false, code: 'PROFILE_REQUIRED', error: 'Please complete your profile before creating an itinerary.' },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true, userId, profileId: String(profile.id) });
}
