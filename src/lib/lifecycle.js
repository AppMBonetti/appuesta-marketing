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
