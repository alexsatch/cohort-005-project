import { and, eq, isNull } from "drizzle-orm";
import { db } from "~/db";
import { coupons } from "~/db/schema";

// ─── Team Seats ───
// Each row of the `coupons` table is a Team Seat (see GLOSSARY.md): one paid
// place from a team purchase, claimed when a learner redeems its Coupon
// (`code`). A seat is a Voided Team Seat once `voidedAt` is set.

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const VOIDED_TEAM_SEAT_MESSAGE =
  "This Team Seat was refunded and can no longer be claimed.";

/**
 * Voids every unclaimed Team Seat of a team purchase, because the purchase was
 * refunded. Claimed seats and seats of other purchases are left alone. Returns
 * how many seats were voided.
 */
export function voidUnclaimedTeamSeats(
  purchaseId: number,
  now: Date = new Date(),
  tx: Transaction | typeof db = db
): number {
  const result = tx
    .update(coupons)
    .set({ voidedAt: now.toISOString() })
    .where(
      and(
        eq(coupons.purchaseId, purchaseId),
        isNull(coupons.redeemedAt),
        isNull(coupons.voidedAt)
      )
    )
    .run();

  return result.changes;
}

/** Whether a Team Seat is voided, so its Coupon can no longer be redeemed. */
export function isVoidedTeamSeat(seat: { voidedAt: string | null }): boolean {
  return seat.voidedAt !== null;
}
