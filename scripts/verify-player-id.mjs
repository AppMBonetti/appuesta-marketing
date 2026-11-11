// The displayed player id, checked in the build.
//
// The database keys on the 9-digit form the importers produce
// (`playerIdFromExternal` keeps the last 9 digits of `222100000109`), and every
// screen shows the 12-digit form the backoffice uses, because that is the one
// a person can paste into it. One helper does the translation in twelve
// places, which is exactly the shape of thing that goes wrong quietly:
// applying it twice would read `222222100000109` and still look like an id.
import { fullPlayerId, playerIdHaystack, PLAYER_ID_PREFIX } from "../src/lib/playerId.js";

const failures = [];
const check = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures.push(`${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
};

check("the prefix is the one verified in deposit_periods", PLAYER_ID_PREFIX, "222");

// The real case, from the data: 3,620 rows of deposit_periods carry the
// original external id and every one is 12 digits beginning 222.
check("a stored id becomes the backoffice id", fullPlayerId("100000109"), "222100000109");
check("and is 12 digits long", fullPlayerId("100000109").length, 12);
check("numbers are accepted too", fullPlayerId(100000001), "222100000001");

// The trap this file exists for.
check("applying it twice changes nothing", fullPlayerId(fullPlayerId("100000109")), "222100000109");
check("a thrice-applied id is still right", fullPlayerId(fullPlayerId(fullPlayerId("100002247"))), "222100002247");

// A short id that merely starts with 222 is a stored id, not a display one,
// and must still get its prefix.
check("a stored id that happens to start with 222 is still prefixed",
  fullPlayerId("222000001"), "222222000001");

// Empty is empty, never a bare "222" floating in a table cell.
check("null renders as nothing", fullPlayerId(null), "");
check("undefined renders as nothing", fullPlayerId(undefined), "");
check("an empty string renders as nothing", fullPlayerId(""), "");

// Search has to find a player from either form, because one is on the screen
// and the other is in somebody's head.
const hay = playerIdHaystack("100000109");
check("the haystack holds the stored form", hay.includes("100000109"), true);
check("the haystack holds the backoffice form", hay.includes("222100000109"), true);
check("an empty id has an empty haystack", playerIdHaystack(""), "");

if (failures.length) {
  console.error("verify-player-id FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("verify-player-id: 13 cases pass, the displayed id is the backoffice id and prefixing is idempotent.");
