/**
 * Run: npm run test:guide-contact-policy
 *
 * Auto-share client contact + guide personal-contact strikes (suspend after 2).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  detectSensitiveContact,
  maskSensitiveChatContent,
} from "../lib/chat-message-sanitize.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function assert(name: string, cond: boolean) {
  if (!cond) {
    console.error(`  ✗ ${name}`);
    failed += 1;
  } else {
    console.log(`  ✓ ${name}`);
  }
}

function read(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

/** Mirror of lib/guide-client-contact.ts — keep in sync (node scripts cannot resolve @/). */
function guideMaySeeClientContact(opts: {
  offerStatus?: string | null;
  priceConfirmationStatus?: string | null;
}): boolean {
  const offer = String(opts.offerStatus || "").toLowerCase();
  if (["hired", "accepted", "completed"].includes(offer)) return true;
  const pc = String(opts.priceConfirmationStatus || "").toLowerCase();
  return pc === "requested" || pc === "confirmed";
}

console.log("\n=== detectSensitiveContact ===\n");

assert("detects email", detectSensitiveContact("email me at guide@example.com please"));
assert("detects +phone", detectSensitiveContact("WhatsApp +81 90-1234-5678"));
assert("detects wa.me", detectSensitiveContact("https://wa.me/819012345678"));
assert("ignores plain logistics", !detectSensitiveContact("Meet at Kyoto station at 10am"));
assert("ignores price-only", !detectSensitiveContact("Total is ¥50,000 for the group"));

console.log("\n=== mask still hides contact ===\n");

const masked = maskSensitiveChatContent("Call +81 90-1234-5678 or guide@example.com");
assert("mask replaces contact", masked.includes("[contact hidden]"));
assert("mask drops raw email", !masked.includes("guide@example.com"));

console.log("\n=== share gate + strike limit ===\n");

const policySrc = read("lib/guide-contact-policy.ts");
const contactSrc = read("lib/guide-client-contact.ts");
assert(
  "strike limit is 2",
  /GUIDE_CONTACT_STRIKE_LIMIT\s*=\s*2/.test(policySrc)
);
assert(
  "lib share gate matches helper",
  contactSrc.includes('["hired", "accepted", "completed"]')
);
assert(
  "hired guide may see client contact",
  guideMaySeeClientContact({ offerStatus: "hired" })
);
assert(
  "bidder may not see client contact",
  !guideMaySeeClientContact({ offerStatus: "pending" })
);
assert(
  "price requested unlocks client contact",
  guideMaySeeClientContact({ priceConfirmationStatus: "requested" })
);

console.log("\n=== wiring ===\n");

assert(
  "confirm booking requires client contact",
  read("app/api/jobs/confirm-booking/route.ts").includes("missingClientContact")
);
assert(
  "confirm booking records share audit",
  read("app/api/jobs/confirm-booking/route.ts").includes("recordClientContactShared")
);
assert(
  "confirm button collects client contact",
  read("components/itineraries/confirm-booking-button.tsx").includes("clientWhatsApp")
);
assert(
  "chat POST enforces guide contact policy",
  read("app/api/chats/messages/[chatId]/route.ts").includes("enforceGuideContactSharePolicy")
);
assert(
  "suspend helper shared",
  read("app/api/admin/user/suspend/route.ts").includes("suspendMarketplaceUser")
);
assert(
  "migration indexes audit log",
  read("migrations/20260907_client_contact_share_and_guide_strikes.sql").includes(
    "security_audit_log_actor_event_idx"
  )
);

console.log(failed === 0 ? "\nAll checks passed\n" : `\n${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
