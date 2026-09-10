import {
  parseIntakeData,
  type ItineraryIntakeData,
} from "@/lib/itinerary-intake";

export type GuideClientContact = {
  clientFullName: string | null;
  clientEmail: string | null;
  clientWhatsApp: string | null;
  notesForGuide: string | null;
};

/**
 * Client PII from intake is only for the assigned guide — not every bidder on the board.
 * Hired / accepted / completed, or after the advisor starts price confirmation.
 */
export function guideMaySeeClientContact(opts: {
  offerStatus?: string | null;
  priceConfirmationStatus?: string | null;
}): boolean {
  const offer = String(opts.offerStatus || "").toLowerCase();
  if (["hired", "accepted", "completed"].includes(offer)) return true;
  const pc = String(opts.priceConfirmationStatus || "").toLowerCase();
  return pc === "requested" || pc === "confirmed";
}

export function clientContactFromIntake(
  intakeRaw: unknown,
  notesForGuide?: string | null
): GuideClientContact {
  const intake: ItineraryIntakeData = parseIntakeData(intakeRaw);
  const name = intake.clientFullName?.trim() || null;
  const email = intake.clientEmail?.trim() || null;
  const whatsapp = intake.clientWhatsApp?.trim() || null;
  const notes = notesForGuide?.trim() || null;
  return {
    clientFullName: name,
    clientEmail: email,
    clientWhatsApp: whatsapp,
    notesForGuide: notes,
  };
}

export function clientContactHasContent(c: GuideClientContact | null | undefined): boolean {
  if (!c) return false;
  return Boolean(
    c.clientFullName || c.clientEmail || c.clientWhatsApp || c.notesForGuide
  );
}
