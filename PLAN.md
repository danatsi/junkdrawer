# Junk Drawer — project & technical plan

Companion to `link-box-spec.md`. The spec decides *what* to build and how it should look;
this decides *how it gets built*, in what order, and what's still unresolved.

---

## 0. Decisions made (resolving spec §6 open questions)

| # | Question | Decision |
|---|---|---|
| — | App framework | **Next.js (App Router, TypeScript) on Vercel** — UI and capture endpoint in one repo/deploy/domain |
| — | yt-dlp | **Deferred out of v1.** The Shortcut note is the Instagram signal. No Python service, no second platform. |
| 1 | Tag vocabulary | **Four fixed + one freeform**: `shopping`, `watch`, `recipe`, `read`, plus at most one specific freeform tag |
| 6 | PWA | **Minimal PWA** — `manifest.json`, 180px apple-touch-icon, `theme-color`. No service worker. |

Freeform tags are stored in `tags[]` but the chip bar renders only the four core tags + `all`,
so the filter row stays fixed-width and predictable while search (Phase 6) can still hit the freeform ones.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15, App Router, TypeScript | Route Handlers give the capture endpoint for free; Server Components keep every API key server-side |
| Hosting | Vercel (free) | Same deploy as the frontend; `waitUntil` lets the Shortcut get a fast 200 while enrichment runs on |
| Database | Supabase Postgres (free) | Per spec §3.1 |
| DB access | `@supabase/supabase-js` with the **service-role key, server-side only** | Single-user app, no browser DB client, so no RLS policy work and no anon key in the bundle |
| HTML parsing | `node-html-parser` | ~10x lighter than cheerio; we only need four `og:*` meta tags |
| LLM | Gemini Flash via `@google/genai`, `responseSchema` for strict JSON | Per spec §3.3; schema mode removes JSON-parsing failure as a class of bug |
| Movie data | TMDb (overview, imdb_id, trailer) → OMDb (IMDb rating) | Per spec §3.4 |
| Gestures | Framer Motion — **Phase 6 only** | Not pulled in until swipe-to-archive is actually built |
| Styling | Plain CSS Modules + tokens in `app/globals.css` | The design is a token set plus one stylesheet per component. Tailwind would be a rewrite for no gain. |
| Fonts | None — SF via the system stack | The device already has it (spec §4.1), so there's no webfont request at all. Retired `next/font` and IBM Plex Sans Hebrew. |

**Deliberately not in the stack:** no ORM (four queries total), no state library (one list, one filter string,
`useState` covers it), no auth provider (see §5), no icon package (spec §7 — inline SVGs, already written in the mock).

### Repo shape

```
junkdrawer/
  app/
    layout.tsx                 fonts, tokens, manifest link
    page.tsx                   Server Component: fetch links -> <LinkList>
    api/
      capture/route.ts         POST from the iOS Shortcut (bearer auth)
      links/[id]/route.ts      PATCH status (archive), DELETE
  components/
    LinkList.tsx               'use client' — chip bar + rows
    LinkRow.tsx                row body / chevron panel / WhatsApp button
    Icons.tsx                  chevron, star, whatsapp SVGs
  lib/
    supabase.ts                service-role client (server-only)
    enrich.ts                  orchestrates the pipeline
    og.ts                      fetch + parse Open Graph
    gemini.ts                  tag/title/summary call
    movies.ts                  TMDb + OMDb chain
    types.ts                   Link type, shared with the DB shape
  styles/tokens.css            (exists)
  public/manifest.json, icon-180.png
  mock.html                    (kept as the design reference)
```

### Environment variables

```
SUPABASE_URL                 SUPABASE_SERVICE_ROLE_KEY
CAPTURE_TOKEN                # bearer secret the Shortcut sends
APP_UNLOCK_SECRET            # frontend gate, see §5
GEMINI_API_KEY
TMDB_API_KEY                 OMDB_API_KEY
```

All server-side. Nothing is `NEXT_PUBLIC_`.

---

## 2. Data model

Spec §3.2 as written, with additions the spec implies but doesn't list:

```sql
create table links (
  id            uuid primary key default gen_random_uuid(),
  url           text not null,
  note          text,
  title         text,
  description   text,
  image_url     text,
  domain        text,
  tags          text[] not null default '{}',
  status        text   not null default 'unread',   -- unread | done
  imdb_rating   text,
  trailer_url   text,
  -- additions:
  type          text   not null default 'link',     -- link | screenshot (v2, added now to avoid a later migration)
  enrichment    text   not null default 'pending',  -- pending | ok | failed
  enrich_error  text,
  keywords      text[] not null default '{}',       -- bilingual search vocabulary (Phase 6)
  reassurance_score smallint,                       -- 0-10, read-tagged books only
  reassurance_reason text,                          -- one sentence saying why, moves with the score
  poster_url    text,                               -- the show's own poster; outranks image_url as the thumbnail
  rating_source text,                               -- imdb | tmdb, which service imdb_rating came from
  imdb_id       text,                               -- set whenever TMDb knew the title; makes the badge a link
  created_at    timestamptz not null default now()
);

create index links_created_idx on links (created_at desc);
create index links_status_idx  on links (status);
create index links_tags_idx    on links using gin (tags);
```

Three additions worth calling out:

- **`enrichment` / `enrich_error`** — the capture endpoint returns before enrichment finishes, so a row
  can exist with no title. Without this column the UI can't tell "still working" from "permanently thin",
  and a Gemini outage silently produces untitled rows with no trace. The row renders with its domain as a
  placeholder title while `pending`.
- **`type`** — free to add now, a migration later. The v2 screenshot work (spec §5.3) needs it.
- **`keywords`** — the search vocabulary, generated by the same Gemini call that writes the tags:
  the words you'd type to find the row later, in Hebrew *and* English whatever language the page
  was in. It's a separate column rather than more `tags` because tags are a fixed vocabulary the
  chip bar renders, and a dozen search terms per row would swamp it. Never displayed.

---

## 3. Build phases

Ordered so there's something real and usable as early as possible. Phases 1–3 give a working app.

### Phase 1 — Foundation
- `create-next-app` (TS, App Router), git init, Vercel project linked.
- Supabase project + the schema above.
- `tokens.css` into `app/layout.tsx`, fonts via `next/font`.
- `lib/supabase.ts`, `lib/types.ts`.
- Deploy a "hello" page to confirm the pipe works end to end.

**Done when:** a deployed URL renders, and a hand-inserted Supabase row can be read by a server component.

### Phase 2 — Capture path
- `POST /api/capture`: bearer check against `CAPTURE_TOKEN`, parse `{ url, note }`, derive `domain`,
  insert with `enrichment: 'pending'`, return `201` immediately.
- Build the iOS Shortcut per spec §2.2 (URL input → `if contains instagram.com` → optional text prompt → POST).
- Reject non-http(s) URLs; treat a duplicate URL as an update rather than a second row.

**Done when:** sharing a link from Safari on the phone puts a row in Supabase within a second or two.

### Phase 3 — The list
Port `mock.html` to React, one-for-one. It already implements every behaviour in spec §4.2–4.4, so this is
a translation, not a design pass. Carry over specifically:
- chevron and WhatsApp `stopPropagation` so neither fires the row's link-out,
- the reserved-but-invisible chevron slot so the WhatsApp icon never shifts,
- panel height from `scrollHeight`, not a guessed `max-height`.

Chip bar renders the fixed four + `all` (not derived from data — that's the one intentional change from the mock).
Rows sorted `created_at desc`, `status = 'unread'` only.

**Done when:** links saved from the phone appear in the deployed list, tappable, shareable to WhatsApp.

### Phase 4 — Enrichment: OG + Gemini
- `lib/og.ts` — `fetch` with a browser UA, 5s `AbortSignal.timeout`, parse `og:title`/`og:description`/`og:image`.
  Non-HTML content types and non-200s return empty rather than throwing.
- `lib/gemini.ts` — prompt per spec §3.3 step 3: fixed vocabulary, note-as-primary-signal, infer-from-URL
  when data is thin, title <8 words, summary <20 words, `responseSchema` enforcing
  `{ clean_title, summary, tags }`.
- `lib/enrich.ts` — orchestrates, updates the row, sets `enrichment: 'ok' | 'failed'`.
- Wire into capture with `waitUntil()` so the Shortcut still gets its fast 200.
- Manual retry: `POST /api/links/[id]/enrich` for rows stuck at `failed`.

**Done when:** a saved Zara link comes back titled "Wool overshirt, camel" tagged `shopping`, with a thumbnail.

### Phase 5 — Watch sub-pipeline
- `lib/movies.ts`: TMDb `/search/multi` → `/external_ids` → `/videos` (filter `type=Trailer`, `site=YouTube`)
  → OMDb by `imdb_id` for the real IMDb rating.
- Runs only when Gemini returned the `watch` tag. Every step optional — no trailer or no rating degrades
  to a normal row rather than failing the save.
- Score badge + expanded description + trailer link (already in the mock).
- Also fetches the **poster** and copies it into our own bucket, on the same reasoning the scraped
  product image gets: hot-linking image.tmdb.org would tell TMDb which shows are in the drawer on
  every render. It becomes the row's thumbnail, outranking `image_url`.
- This chain keys off the `watch` tag and the title and has no idea where either came from, so a
  **screenshot** of a film or show reaches all of it (spec §5.5). That was already true for the
  rating and the trailer — the screenshot row just rendered neither, and hardcoded its tag pill to
  the word "screenshot", so a saved show looked exactly like a saved receipt.
- The rating **falls back to TMDb's `vote_average`** when OMDb doesn't answer, and the row records
  which service it got (spec §3.4). OMDb was the single source, and it goes quiet for four ordinary
  reasons — no key, no `imdb_id`, an `"N/A"`, the 1,000/day quota — each of which left the row with
  no rating at all.
- **`POST /api/backfill-watch`** fills these in on rows that predate them. Deliberately *not* a
  re-run of enrichment, for the reason `/api/reindex` documents: that would re-scrape the page,
  re-hit Gemini and overwrite a good title with whatever the site serves today. It runs the watch
  sub-pipeline alone, keyed on the title the row already has, and writes only the five fields that
  sub-pipeline owns — additively, so an existing rating is kept unless `?force=1`. Incremental and
  reports `remaining`, like reindex.

**Done when:** saving an IMDb or Netflix URL yields a row with a star badge and a working trailer link.

### Reassurance score — the `read` sub-pipeline's counterpart to Phase 5
Same shape as the watch score, but there's no TMDb/OMDb to ask "will I like this" — that's not a
lookup, it's a taste judgment, so `lib/gemini.ts` asks the model directly instead of chaining to
another service:
- One fixed personal taste profile (single-user app) lives in the Gemini prompt (`READ_TASTE_PROFILE`)
  and is folded into the same call that already writes tags and summary — no second request.
- `reassurance_score`, 0-10, only when tags includes `read` and the row is a specific book (never a
  store, list, or article about books); null otherwise, same as `imdb_rating` is null off `watch`.
- `reassurance_reason` carries the one-sentence case for that number, written *after* it in the
  schema's property order so the sentence justifies a score already committed to rather than the
  score being rounded to fit a sentence the model talked itself into. The two are written and
  cleared together: a score under last run's reasoning would be worse than a score with none.
  It's kept out of `description`, which holds the book's own synopsis — that field is about the
  book, this one is about the reader, and `description` is also what the search index and the
  watch pipeline write.
- Renders in the same score badge as the watch tag (`components/ScoreBadge.tsx`, shared by both row
  types), with the reasoning in the row's expanded panel, set off by a leading rule. The glyph
  differs though — a heart, not the rating's star (spec §4.2).
- **`POST /api/backfill-books`** scores books that were saved before any of this existed. The score
  is normally one field of the big enrichment call, and re-running that over an old row would
  re-scrape the page and overwrite a good title — the objection `/api/reindex` documents — so
  `generateReassurance` asks only the missing question, from the title, summary, note and OCR the
  row already has. `read` covers articles and shops as well as books, so the model returns
  `is_book` explicitly and rows that aren't one are left null rather than given a meaningless
  number; they're reported as `skipped`, which is what explains a `remaining` that never reaches
  zero.
  `is_book` is asked for rather than inferred from a score of 0 because, in this call, there's no
  `tags` array arriving alongside to tell "you'd hate this" apart from "this isn't a book".

**Done when:** saving a specific book comes back with a 0-10 badge reasoned from the taste profile
and a sentence in its panel saying why, and a shopping or recipe row never shows either.

### Phase 6 — Polish (resolves the remaining spec §6 questions)
- **Frontend gate** (§5 below) — do this before the URL is shared anywhere.
- **Swipe** (open q2) — **built.** Left-swipe uncovers two buttons behind the row, Archive and
  Delete, and you tap one. Either way the row leaves the list at once and an undo toast stands
  for 5s.
  - Archive is the old behaviour: `status = 'done'`, written immediately, undo sets it back.
  - Delete is new and is the only irreversible write in the app. `DELETE /api/links/[id]` also
    removes the row's own image from its bucket — a favicon is a plain https URL shared by every
    row from that domain, so `parseStorageRef` refuses it and it can't be taken out from under
    its neighbours.
  - **The undo for a delete is the delay itself.** The request isn't sent when you tap; it's sent
    when the toast expires, so undo is simply never sending it. No soft-delete column, and no
    "restore" path that would have to put back an image already gone.
  - That delay is held in a **ref owned by the list**, not by the toast's timer, and every path
    that closes the undo window flushes it: the timer, a second swipe, `pagehide`, and unmount.
    Holding it in the toast is what the first cut did, and it silently lost deletes — the row
    left the list and stayed in the table. Two ways in: deleting a second row replaced `pending`
    and cleared the first row's timer, and moving to another page in the app unmounted the list
    without firing `pagehide` at all. Both are covered by browser tests now. Taking the id out
    of the set is what claims the send, so racing flushes still send exactly once.
  - `destroy()` also checks `response.ok`. `fetch` rejects on a network failure and nothing
    else, so a server that refused — a 404 from the site gate, a 500 from a bad key — used to
    arrive looking exactly like success.
  - The first cut of this decided by distance instead — archive past 40% of the row's width,
    delete past 75%. It was wrong in a way worth recording: the destructive outcome was the one
    you got by swiping *harder*, and at 75% your thumb is over the label that would have told you
    so. Two buttons cost one extra tap and remove the entire class of mistake.
- **Empty state** (open q3) — proposal: wordmark + one line of sentence-case copy, no illustration.
  Different copy for "nothing saved yet" vs "nothing tagged `recipe`".
- **Search** (open q4) — **built.** A field revealed by the icon in the header, filtering the
  already-fetched list client-side. Matching is bilingual, which is the whole difficulty: a Zara
  page scraped in English has to come back for `מכנסיים` and a Hebrew recipe for `chicken`, and
  no amount of substring matching on the stored title gets there. Two layers, in `lib/search.ts`
  and the Gemini schema:
  - **vocabulary** — enrichment stores `keywords`, the Hebrew *and* English terms for what the
    row actually is. This is the layer that crosses languages at all.
  - **morphology** — the query and the row are both normalised (niqqud and geresh stripped, so
    `גינס` and `ג'ינס` are one word) and matched per token on a light stem, so `מכנס` reaches
    `מכנסיים`, `חולצה` reaches `חולצות`, and `shirt` reaches `shirts`. Multi-word queries are AND.
  Also matched: title, domain, note, summary, a screenshot's OCR'd text, the URL slug, and every
  tag including the freeform ones that never get a chip.
  Rows enriched before the column existed are filled in by `POST /api/reindex`, which regenerates
  the terms only — re-running enrichment would re-scrape the page and re-hit TMDb to arrive back
  at the title it already has. It's incremental and reports `remaining`, so a big drawer is a
  matter of calling it again.
  Deliberately not Postgres full-text search: `to_tsvector` has no Hebrew configuration, and the
  list is already fetched whole for the tag filter.
- **Multi-expand** (open q5) — proposal: allow several panels open at once. Auto-close is the more
  opinionated behaviour and there's no cost to leaving two open.
- **PWA** — manifest, icon, `display: standalone`, and a `theme-color` per appearance so the
  status bar doesn't disagree with the app in one of them.
- Loading/skeleton state for `enrichment: 'pending'` rows.

### Phase 7 — v2 screenshots
Spec §5, unchanged, built only once phases 1–6 have been in daily use. Cloudflare R2 + client-side
compression, Gemini vision, the whole-row-toggle row variant and full-screen viewer.

---

## 4. Enrichment flow

```
Shortcut POST /api/capture
   │  bearer check, parse url + note, derive domain
   ├─ insert row (enrichment: pending) ──► 201 to the Shortcut   [fast path ends here]
   │
   └─ waitUntil( enrich(row) ):
        1. OG scrape ─────────────► { ogTitle, ogDesc, ogImage } or {}
        2. Gemini Flash ──────────► { clean_title, summary, tags, keywords }
             inputs: url, domain, note, OG data
             note takes priority when present
        3. if tags includes 'watch':
             TMDb /search/multi ──► tmdb_id
             TMDb /external_ids ─► imdb_id
             TMDb /videos ───────► trailer_url
             OMDb ?i=imdb_id ────► imdb_rating
        4. update row, enrichment: ok
      any failure ──► enrichment: failed + enrich_error, row still usable
```

Two URL shapes get special handling before step 2, because for both of them the scraped page is
actively misleading rather than merely thin:

- **An IMDb title URL** is resolved by id first (step 1b), so the film is looked up rather than
  guessed from `/title/tt1442437/`.
- **A page of search results** has its scraped title, description and image dropped wholesale
  (step 1c). A Google results page scrapes as the bare title "Google Search" with no description
  and no image, whatever was being looked for — so the terms in `?q=` become the subject and the
  title, and the model is told to name the thing rather than the search. Before this, a search
  for a book was saved as a row called "Google Search".

The row is never blocked on enrichment. Worst case it shows `zara.com` as its title until retried.

---

## 5. Gap in the spec: the frontend has no auth

Spec §3.1 covers the *capture* endpoint (bearer token from the Shortcut) but nothing protects the
*site*. As written, anyone with the URL reads your saved links. Vercel's password protection is a paid
feature, and a full auth provider is heavy for one user.

**Built:** middleware (`proxy.ts`) over every route. Enter `APP_UNLOCK_SECRET` on `/unlock` once per
device; it sets a signed, httpOnly, one-year cookie. No dependency, no auth provider.

The first cut had no login screen at all — an `/unlock?k=<secret>` link, and a bodyless 404 for anything
without the cookie, so that a locked site didn't advertise it was there. Two problems in practice: the
404 is also what a broken deploy looks like, so being locked out was indistinguishable from an outage;
and a secret in a URL ends up in history, referers and screenshots. Now a locked browser is redirected
to a password page, and the secret is a five-word passphrase (~74 bits) submitted by POST. API routes
still get the bodyless 404, since a `fetch` has no use for a login page. The site admits it exists; the
passphrase is what keeps it shut.

---

## 6. Cost

Everything sits on free tiers at the expected ~3 links/day, and the ceilings aren't close:

| Service | Free tier | Expected use |
|---|---|---|
| Vercel | 100GB bandwidth, generous function invocations | ~100 invocations/month |
| Supabase | 500MB DB, 50k MAU | a few MB of text, 1 user |
| Gemini Flash | ~500–1,500 req/day, 10–15 req/min | ~3 req/day |
| TMDb | unmetered for personal use | a handful/week |
| OMDb | 1,000 req/day | a handful/week |

The only realistic ceiling is Gemini's **per-minute** limit, and only during a bulk import — not at daily pace.
If a bulk import ever happens, enrichment needs a queue; it doesn't need one now.

---

## 7. Risks

| Risk | Handling |
|---|---|
| Site is publicly readable | §5 — do the gate in Phase 6, before sharing the URL |
| Row saved but enrichment dies | `enrichment` column + manual retry endpoint; row stays usable |
| Sites blocking server-side scraping (not just Instagram) | Gemini infers from URL/domain — spec §3.3 already instructs this |
| `waitUntil` hits Vercel's function timeout on a slow watch chain | Per-call timeouts; watch sub-pipeline degrades step by step rather than failing whole |
| Gemini returns tags outside the vocabulary | `responseSchema` enum on the core tags, freeform confined to one separate field |
| Duplicate saves of the same URL | Capture upserts on `url` |

---

## 8. Still open

- **§6 q7** — screenshot share icon: WhatsApp-branded or generic. v2, no need to decide yet.
- **§6 q8** — Gemini fallback for image-only screenshots with no text. v2.
- Phase 6 proposals above (empty state, multi-expand) are proposals, not decisions — worth
  confirming when Phase 6 starts rather than now, since daily use will inform them. Search and
  the swipe are no longer among them: both are built and described above.
