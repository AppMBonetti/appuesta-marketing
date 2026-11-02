-- APPLIED 2026-11-02. The real players flagged internal by a substring match.
--
-- internal_name_patterns was `test,prueba,demo,qa`, matched with
-- `like '%' || pattern || '%'` against username and email. Two of those four
-- patterns caught nothing real and three real players:
--
--   juliolorabaldemora@gmail.com   "demo" inside the surname Baldemora
--   moisesbaldemora07@gmail.com    same
--   juniordemota1@gmail.com        "demo" inside the surname Demota
--
-- plus five accounts whose random 10-character email prefix happens to contain
-- `qa` (rw8qagyj4n, qagk0y9s5o, c6kqa9gkrp, qamy6k2kqm, rch1nd7qau).
--
-- The obvious fix -- match on word boundaries -- is wrong here, and only
-- checking the data showed it. The house convention glues the pattern to a
-- name: `cuentatesting`, `josetest10`, `marcostest1008`, `mbtest6@gmail.com`,
-- `joseurenatesting@gmail.com`. A bounded match would have released all of
-- those, including DOP 5,000 and DOP 1,500 of genuine test deposits.
--
-- What actually separates the false positives is length, not boundaries: `demo`
-- and `qa` are short enough to collide with Dominican surnames and random
-- strings, `test` and `prueba` are not. And every `demo` match in the data is
-- either a surname or the DEMON01..DEMON31 ring, never a genuine demo account,
-- so the pattern becomes `demon` -- keeping the ring, dropping the surnames.
-- `qa` goes entirely: it flagged nothing but noise.
update public.app_settings
   set value = 'test,prueba,demon'
 where key = 'internal_name_patterns';

-- Checked before applying: exactly 8 accounts change, all released, none newly
-- flagged, every DEMON* account still flagged. Of the 8, three are real players
-- and five are disposable-email signups -- releasing those into the book would
-- have been a worse error than the one being fixed, so they are held out under
-- the reason that actually describes them. `excluded`, not `restricted`: these
-- were never customers.
update public.players
   set excluded = true,
       exclusion_reason = 'Correo desechable — registro fraudulento',
       excluded_at = coalesce(excluded_at, now())
 where id in ('100003924', '100003960', '100004233', '100004341', '100004751')
   and not excluded;

-- tanpony.com is where three of those five sit, and it was not on the list.
update public.app_settings
   set value = value || ',tanpony.com'
 where key = 'disposable_email_domains'
   and position('tanpony.com' in value) = 0;

select public.refresh_internal_flags();

-- ---------------------------------------------------------------------------
-- NOT done here, deliberately: applying the disposable list as a rule
-- ---------------------------------------------------------------------------
--
-- `disposable_email_domains` is a note, not a rule. The 138 accounts marked
-- "Correo desechable — registro fraudulento" were excluded by a one-off sweep
-- in August and nothing has applied the list since, so adding a domain to
-- app_settings does nothing on its own. That is how tanpony.com reached 100
-- accounts unnoticed.
--
-- Making refresh_internal_flags() apply it was written, tested in a rolled-back
-- transaction, and then held back, because of what the test showed:
--
--   707 accounts would be excluded, across seven domains still taking signups
--   through 1 November, holding DOP 400 between all of them -- and 657 of them
--   registered in October, which is 24% of the month's 2,746 registrations.
--
-- October registrations would read 2,089 instead of 2,746, and growth against
-- September would go from +224% to +147%. That is Marcos's headline figure, so
-- it is his call and not a side effect of fixing three surnames. The rule is
-- ready; it only ever sets `excluded`, never clears it, and skips any row that
-- already carries an exclusion_reason so an operator's own decision via
-- set_player_excluded() is never overwritten.
