import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSupabaseServer } from '@/lib/supabaseServer'
import { denyIfActivityNotApproved } from '@/lib/activity-approval'
import {
  intakeDataForApi,
  normalizeBuildMode,
  parseIntakeData,
  validateIntakeAdvisorClientSection,
  validateIntakeForPagodaBuild,
  type ItineraryIntakeData,
} from '@/lib/itinerary-intake'
import {
  DEFAULT_PDF_SUBTITLE,
  DEFAULT_PDF_TITLE,
  itineraryDayIds,
  mergeArrivalLocationsFromStays,
} from '@/lib/itinerary-pdf-defaults'
import { sendPagodaBuildIntakeNotification } from '@/lib/mailer'
import {
  deriveBookingProgress,
  pickLeadingBookingApplication,
} from '@/lib/booking-status'
import {
  DEFAULT_COMMISSION_SETTINGS,
  getAgentDisplayTotalRounded,
} from '@/lib/tour-price'
import { DEFAULT_ADVISOR_MARKUP_PCT } from '@/lib/advisor-markup'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  try {

    const url = new URL(req.url);
    let userId = url.searchParams.get("userId");
    if (!userId) {
      const jar = await cookies();
      userId = jar.get("userId")?.value ?? null;
    }
    if (!userId) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

    const supabase = getSupabaseServer()
    const activityBlock = await denyIfActivityNotApproved(userId, supabase)
    if (activityBlock) return activityBlock

    const { data: itineraries, error } = await supabase
      .from('itineraries')
      .select('id, name, location, description, status, start_date, end_date, image, created_at, updated_at, arrival_transfer, arrival_flight_number, arrival_flight_time, departure_transfer, departure_flight_number, departure_flight_time')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) return NextResponse.json({ ok: false, error: 'Database error' }, { status: 500 })

    const items = itineraries ?? []
    if (items.length === 0) {
      return NextResponse.json({ ok: true, itineraries: items })
    }

    const itineraryIds = items.map((it: { id: string }) => it.id)

    // Booking progress and price summary per itinerary.
    const { data: jobs } = await supabase
      .from('jobs')
      .select(
        `id, itinerary_id, job_available, is_active,
         job_applications(applicant_id, offer_status, guide_price, hire_id, is_candidate, is_finalist, submitted_at, price_confirmation_status)`
      )
      .in('itinerary_id', itineraryIds)

    type SummaryApplication = {
      applicant_id?: string | null
      offer_status?: string | null
      guide_price?: number | null
      hire_id?: string | null
      is_candidate?: boolean | null
      is_finalist?: boolean | null
      submitted_at?: string | null
      price_confirmation_status?: string | null
    }
    type SummaryJob = {
      id: string
      itinerary_id: string | null
      job_available?: boolean | null
      is_active?: boolean | null
      job_applications?: SummaryApplication[] | null
    }

    const guideIds = [
      ...new Set(
        ((jobs ?? []) as SummaryJob[])
          .flatMap((job) => job.job_applications ?? [])
          .map((app) => app.applicant_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      ),
    ]
    const commissionByGuide = new Map<
      string,
      { marketplace: number; agent: number; vat: number }
    >()
    if (guideIds.length > 0) {
      const { data: commissionRows } = await supabase
        .from('guide_commission_settings')
        .select('user_id, commission_marketplace_pct, commission_agent_pct, vat_rate_pct')
        .in('user_id', guideIds)
      for (const row of commissionRows ?? []) {
        commissionByGuide.set(String(row.user_id), {
          marketplace:
            Number(row.commission_marketplace_pct) ||
            DEFAULT_COMMISSION_SETTINGS.commissionMarketplacePct,
          agent:
            Number(row.commission_agent_pct) ||
            DEFAULT_COMMISSION_SETTINGS.commissionAgentPct,
          vat: Number(row.vat_rate_pct) || DEFAULT_COMMISSION_SETTINGS.vatRatePct,
        })
      }
    }

    type ItineraryBookingSummary = {
      total: number
      open: number
      bidsReceived: number
      inProgress: number
      booked: number
      closed: number
      quotedTotal: number
      bookedTotal: number
    }
    const jobsByItinerary: Record<string, ItineraryBookingSummary> = {}
    itineraryIds.forEach((id: string) => {
      jobsByItinerary[id] = {
        total: 0,
        open: 0,
        bidsReceived: 0,
        inProgress: 0,
        booked: 0,
        closed: 0,
        quotedTotal: 0,
        bookedTotal: 0,
      }
    })
    ;((jobs ?? []) as SummaryJob[]).forEach((job) => {
      const itId = job.itinerary_id
      if (!itId || !jobsByItinerary[itId]) return
      const summary = jobsByItinerary[itId]
      summary.total += 1
      const progress = deriveBookingProgress({
        applications: job.job_applications ?? [],
        jobAvailable: job.job_available,
        isActive: job.is_active,
      })
      if (progress === 'booked') summary.booked += 1
      else if (progress === 'open') summary.open += 1
      else if (progress === 'bids_received') summary.bidsReceived += 1
      else if (progress === 'closed' || progress === 'rejected') summary.closed += 1
      else summary.inProgress += 1

      const lead = pickLeadingBookingApplication(job.job_applications ?? [])
      const guidePrice =
        lead?.guide_price != null && Number.isFinite(Number(lead.guide_price))
          ? Number(lead.guide_price)
          : null
      if (guidePrice != null) {
        const commission = lead?.applicant_id
          ? commissionByGuide.get(String(lead.applicant_id))
          : null
        const customerPrice = getAgentDisplayTotalRounded(
          guidePrice,
          commission?.marketplace ??
            DEFAULT_COMMISSION_SETTINGS.commissionMarketplacePct,
          commission?.agent ?? DEFAULT_COMMISSION_SETTINGS.commissionAgentPct,
          commission?.vat ?? DEFAULT_COMMISSION_SETTINGS.vatRatePct
        )
        summary.quotedTotal += customerPrice
        if (progress === 'booked') summary.bookedTotal += customerPrice
      }
    })

    const itinerariesWithCounts = items.map((it: { id: string; [k: string]: unknown }) => {
      const counts = jobsByItinerary[it.id] ?? {
        total: 0,
        open: 0,
        bidsReceived: 0,
        inProgress: 0,
        booked: 0,
        closed: 0,
        quotedTotal: 0,
        bookedTotal: 0,
      }
      return {
        ...it,
        jobs_count: counts.total,
        unassigned_count: counts.total - counts.booked,
        booking_summary: {
          open: counts.open,
          bidsReceived: counts.bidsReceived,
          inProgress: counts.inProgress,
          booked: counts.booked,
          closed: counts.closed,
          quotedTotal: counts.quotedTotal,
          bookedTotal: counts.bookedTotal,
        },
      }
    })

    return NextResponse.json({ ok: true, itineraries: itinerariesWithCounts })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unexpected error'
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const jar = await cookies()
    const userId = jar.get('userId')?.value
    if (!userId) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

    const body = await req.json().catch(() => ({})) as {
      name?: string
      location?: string
      startDate?: string
      endDate?: string
      imagePath?: string | null
      description?: string | null
      status?: string | null
      highlights?: string[] | null
      // camelCase from client
      arrivalTransfer?: boolean
      arrivalFlightNumber?: string
      arrivalTime?: string
      departureTransfer?: boolean
      departureFlightNumber?: string
      departureTime?: string
      // snake_case alternative
      arrival_transfer?: boolean
      arrival_flight_number?: string
      arrival_flight_time?: string
      departure_transfer?: boolean
      departure_flight_number?: string
      departure_flight_time?: string
      buildMode?: string
      build_mode?: string
      intakeData?: ItineraryIntakeData
      intake_data?: ItineraryIntakeData
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const location = typeof body.location === 'string' ? body.location.trim() : ''
    const startDate = typeof body.startDate === 'string' ? body.startDate : ''
    const endDate = typeof body.endDate === 'string' ? body.endDate : ''
    const imagePath = typeof body.imagePath === 'string' ? body.imagePath : null
    const description = typeof body.description === 'string' ? body.description : null
    const status = typeof body.status === 'string' ? body.status : null
    const highlights = Array.isArray(body.highlights) && body.highlights.every((h) => typeof h === 'string')
      ? body.highlights
      : null

    // Legacy "Request Airport Transfer" fields: accept/ignore so old clients don't break.
    // Placeholders are no longer created — book via Tour Library (Transferz) instead.
    const arrival_transfer = false
    const arrival_flight_number = null
    const arrival_flight_time = null
    const departure_transfer = false
    const departure_flight_number = null
    const departure_flight_time = null

    const build_mode = normalizeBuildMode(body.buildMode ?? body.build_mode)
    const intakeRaw = body.intakeData ?? body.intake_data
    const intakeParsed = parseIntakeData(intakeRaw)
    const intake_data = intakeDataForApi(intakeParsed)

    if (build_mode === 'pagoda_build') {
      const intakeErr = validateIntakeForPagodaBuild(intakeParsed)
      if (intakeErr) {
        return NextResponse.json({ ok: false, error: intakeErr }, { status: 400 })
      }
    } else {
      const section1Err = validateIntakeAdvisorClientSection(intakeParsed)
      if (section1Err) {
        return NextResponse.json({ ok: false, error: section1Err }, { status: 400 })
      }
    }

    if (!name || !location || !startDate || !endDate || !status) {
      return NextResponse.json({ ok: false, error: 'Missing required fields' }, { status: 400 })
    }

    // Basic date validation (YYYY-MM-DD)
    const isoDate = /^\d{4}-\d{2}-\d{2}$/
    if (!isoDate.test(startDate) || !isoDate.test(endDate)) {
      return NextResponse.json({ ok: false, error: 'Invalid date format' }, { status: 400 })
    }

    const supabase = getSupabaseServer()
    const activityBlock = await denyIfActivityNotApproved(userId, supabase)
    if (activityBlock) return activityBlock

    // Fetch profile id for user
    const { data: profile, error: pErr } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()

    if (pErr) return NextResponse.json({ ok: false, error: 'Database error' }, { status: 500 })
    if (!profile?.id) {
      return NextResponse.json(
        {
          ok: false,
          code: 'PROFILE_REQUIRED',
          error:
            'Please complete your profile before creating an itinerary.',
        },
        { status: 400 }
      )
    }

    // Snapshot advisor default markup onto the new itinerary (fallback 15%)
    const { data: ownerUser } = await supabase
      .from('users')
      .select('default_markup_pct')
      .eq('id', userId)
      .maybeSingle()
    const defaultMarkup =
      ownerUser?.default_markup_pct != null && Number.isFinite(Number(ownerUser.default_markup_pct))
        ? Number(ownerUser.default_markup_pct)
        : DEFAULT_ADVISOR_MARKUP_PCT

    const arrival_location = mergeArrivalLocationsFromStays(
      itineraryDayIds(startDate, endDate),
      {},
      intakeParsed.destinationStays
    )

    const insert = {
      user_id: userId,
      profile_id: profile.id as string,
      name,
      location,
      start_date: startDate,
      end_date: endDate,
      image: imagePath,
      description,
      status,
      highlights,
      arrival_transfer,
      arrival_flight_number,
      arrival_flight_time,
      departure_transfer,
      departure_flight_number,
      departure_flight_time,
      build_mode,
      intake_data,
      arrival_location,
      pdf_title: DEFAULT_PDF_TITLE,
      pdf_subtitle: DEFAULT_PDF_SUBTITLE,
      markup_pct: defaultMarkup,
      margin_strategy: null,
    }

    const { data, error } = await supabase
      .from('itineraries')
      .insert(insert)
      .select('id, name, location, start_date, end_date, image, status, build_mode, intake_data, markup_pct, margin_strategy')
      .single()
    if (error) return NextResponse.json({ ok: false, error: 'Insert failed' }, { status: 500 })

    const itineraryId = data?.id
    if (!itineraryId) return NextResponse.json({ ok: false, error: 'Failed to get itinerary ID' }, { status: 500 })

    if (build_mode === 'pagoda_build') {
      try {
        const { data: advisor } = await supabase
          .from('users')
          .select('first_name, last_name, email')
          .eq('id', userId)
          .maybeSingle()

        const { data: admins } = await supabase.from('admin').select('email')
        const adminEmails = (admins ?? [])
          .map((a) => (a as { email?: string }).email)
          .filter((e): e is string => typeof e === 'string' && e.length > 0)

        const advisorName = advisor
          ? `${advisor.first_name || ''} ${advisor.last_name || ''}`.trim() || 'Advisor'
          : 'Advisor'

        await sendPagodaBuildIntakeNotification(adminEmails, {
          itineraryId: String(itineraryId),
          itineraryName: name,
          location,
          startDate,
          endDate,
          advisorName,
          advisorEmail: advisor?.email || '',
          arrivalTransfer: false,
          arrivalFlightNumber: null,
          arrivalFlightTime: null,
          departureTransfer: false,
          departureFlightNumber: null,
          departureFlightTime: null,
          intake: intake_data,
        })
      } catch (emailErr) {
        console.error('[itineraries] Pagoda build intake email failed:', emailErr)
      }
    }

    return NextResponse.json({ ok: true, id: itineraryId, itinerary: data })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unexpected error'
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
