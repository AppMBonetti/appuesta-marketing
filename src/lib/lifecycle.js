// The lifecycle ladder, shared by Segments and the VIP tier drill-down so the
// two cannot disagree about what a stage is called or coloured.
//
// Ordered by where a player sits, not alphabetically, so the strip reads as a
// lifecycle rather than a list. 'Casual' is deliberately absent: it required a
// player with one deposit whose FTD was 30+ days old, and with a single deposit
// the FTD *is* the last deposit, so nothing could ever land there. The database
// keeps the branch as a fallback (see lifecycle_stage) but it is unreachable.
export const STAGES = ["Registered", "New", "Active", "Cooling", "At risk", "Churned"];

export const STAGE_COLORS = {
  Registered: "#8B93A3", New: "#6E9BF2", Casual: "#B073F0", Active: "#3ECB9E",
  Cooling: "#D9A848", "At risk": "#F2994A", Churned: "#E4022B",
};

// Whether a stage change was an improvement is decided in the database, by
// lifecycle_rank(), and arrives on player_stage_moves as `direction`. It is not
// recomputed here: two copies of that order would be two things to keep in step.

/**
 * Stage ordered by health, mirroring `lifecycle_rank()` in the database —
 * which is NOT the funnel order STAGES uses. Registered is the floor and
 * Churned sits just above it, because a churned player has paid once and the
 * climb back is shorter than a signup's. Used to sort the from/to columns of
 * the movement table so they read as the same ladder the direction colours do.
 *
 * Checked against the database: Registered 0, Churned 1, At risk 2, Cooling 3,
 * New 4, Active 5.
 */
export const LIFECYCLE_RANK = {
  Registered: 0, Churned: 1, "At risk": 2, Cooling: 3, New: 4, Active: 5,
};

export const lifecycleRank = stage => LIFECYCLE_RANK[stage] ?? -1;
