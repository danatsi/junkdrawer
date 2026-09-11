# Junk Drawer — technical + design spec

A personal web app for saving links you don't want to lose but don't want to deal with right now — a product to buy, a show to watch, a recipe to try. Single user. Not an iOS app.

This spec is written to hand off to another Claude instance for implementation. It captures every decision made during design so no context is lost.

---

## 1. Product mission

One inbox for links: shopping items, TV/movies, recipes, and anything else worth keeping. Saving must be nearly frictionless (share sheet, one or two taps). Retrieval must be fast to scan — a readable title and the right tags, not a wall of raw URLs.

---

## 2. Capture flow

### 2.1 The core constraint

Safari on iOS does **not** support the Web Share Target API — a web app cannot register itself as a destination in the native share sheet the way native apps (or Android web apps) can. So "tap Share in Safari → pick the app" is not directly available.

### 2.2 Solution: iOS Shortcut

An iOS Shortcut named something like "Save to The Box" appears in the share sheet from any app (Safari, Instagram, etc.).

**Shortcut logic:**
1. Receive the shared URL as input.
2. `If URL contains "instagram.com"`:
   - **Yes** → show a text-input prompt for a short description. The prompt is **skippable/optional** — leaving it blank and continuing is a valid path, not required every time.
   - **No** → skip the prompt entirely.
3. POST JSON to the backend capture endpoint: `{ "url": "<shared url>", "note": "<text or empty string>" }`.

Rationale for branching on the URL's domain rather than the source app: Shortcuts can't reliably detect which app triggered the share sheet, but checking whether the shared URL itself is an Instagram link is simple and catches the same weak-metadata problem even if an Instagram link is shared from somewhere other than the Instagram app (e.g. forwarded via text, opened in Safari, then shared from there).

### 2.3 Why the note matters for Instagram specifically

Instagram blocks/limits server-side scraping of Open Graph metadata for Reels and posts, so titles/descriptions are frequently unavailable automatically. The user's own one-line note becomes the primary signal for generating a clean title/summary in that case, rather than relying on fragile scraping.

---

## 3. Backend architecture

### 3.1 Stack

- **Database**: Supabase (Postgres). Free tier: 500MB DB, 1GB storage, 50k MAU — far beyond what a single-user app needs. Gives an auto-generated REST API on top of the schema.
- **Capture endpoint / enrichment logic**: a serverless function. Vercel functions work for the lightweight scraping/API-calling steps; **the yt-dlp step needs a runtime that isn't a lightweight edge function** (see 3.4) — consider Fly.io or Railway free tier for that specific piece, or a small always-on free VM.
- **Frontend hosting**: Vercel free tier.
- **Auth**: single shared-secret bearer token (this is a single-user app — no need for full account/session auth). The Shortcut includes the token in its POST request header.

### 3.2 Data model

`links` table:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `url` | text | the original shared URL |
| `note` | text | user's optional note from the Shortcut prompt |
| `title` | text | clean, readable title (LLM-generated or OG fallback) |
| `description` | text | short summary (LLM-generated or OG fallback) |
| `image_url` | text | thumbnail, from OG scrape or yt-dlp |
| `domain` | text | parsed from URL, used for fallback tagging and display |
| `tags` | text[] | array column — no separate tags table needed at this scale |
| `status` | text | e.g. `unread` / `done` — used for archive/swipe actions |
| `imdb_rating` | text | nullable, only populated for `watch`-tagged links |
| `trailer_url` | text | nullable, only populated for `watch`-tagged links |
| `reassurance_score` | smallint | nullable, 0-10, only populated for `read`-tagged links that are a specific book — see §3.3 step 3a |
| `created_at` | timestamptz | |

### 3.3 Enrichment pipeline (runs per captured link)

1. **Attempt automatic scrape**: fetch the page HTML, read Open Graph tags (`og:title`, `og:description`, `og:image`). Free — plain HTTP fetch + parsing, not an API call.
2. **If the URL is Instagram** (or the plain scrape returns weak/empty data) and it looks like a video/reel: fall back to **yt-dlp** (open source, free, no API key) to extract title, thumbnail, uploader, duration.
   - yt-dlp is unofficial (technically against Instagram's ToS) but actively maintained and the practical standard for this. Alternative is Meta's official oEmbed API, which requires App Review for general-purpose use — disproportionate friction for a personal tool.
   - yt-dlp needs a real Python runtime with its dependencies — won't run in a lightweight edge function. Host this step separately (see 3.1).
3. **Tag + clean title/summary generation**: send the URL, domain, user note (if present), and whatever OG/yt-dlp data was retrieved to **Gemini Flash (free tier)**. Ask for strict JSON:
   ```json
   { "clean_title": "...", "summary": "...", "tags": ["...", "..."] }
   ```
   - Give the model a fixed tag vocabulary to prefer, plus room for one specific freeform tag (exact vocabulary still to be finalized — see Open Questions).
   - Title under ~8 words, summary under ~20 words.
   - If the user's note is present, treat it as the primary signal for title/summary generation — it's usually a better indicator of intent than scraped page text.
   - If OG/yt-dlp data is thin or empty, instruct the model to infer from the URL structure/domain rather than refusing.
   - Note on Gemini's free tier: usage may be used by Google to improve their products (paid tier is excluded from this). Non-issue for personal use, worth knowing.
   - **If tagged `read` and the row is a specific book**: the same call also returns `reassurance_score`, an integer 0-10. There's no TMDb/OMDb equivalent for "will I like this" — no API answers that — so the model reasons it out directly from one fixed personal taste profile embedded in the prompt (see `lib/gemini.ts`), the same way it already writes the tags and summary. Null/omitted for anything that isn't a specific book.
4. **If tagged `watch`** (movie/TV): run the movie enrichment sub-pipeline —
   - **TMDb** (free): search by title (from clean_title or note) → get `overview` (description) and `imdb_id` (via external IDs) → get trailer via the videos endpoint (filter `type=Trailer`, `site=YouTube`) → construct `https://www.youtube.com/watch?v={key}`.
   - **OMDb** (free, 1,000 requests/day): look up by the `imdb_id` from TMDb → get the actual **IMDb rating** (distinct from TMDb's own `vote_average` — these read differently and IMDb's is what's wanted here).
5. Store the row in Supabase.

### 3.4 WhatsApp share (client-side, no backend involvement)

Tapping the WhatsApp icon on a row builds a link client-side:
```
https://wa.me/?text=<url-encoded "{clean_title} {original_url}">
```
Opens WhatsApp (native app or web) with that text pre-filled in the share/contact picker. No API key, no server round-trip.

---

## 4. Frontend design spec

### 4.1 Visual direction

Ink. A dark, neutral tray in which the thumbnails are the only colour. The content is
other people's images, scraped from everywhere, so anything the interface tints competes
with them — the app's job is to be the quietest thing on the screen.

This replaced a warm-cream, serif-titled, terracotta-accented treatment. That combination
is the single most recognisable "generated design" signature there is, and it read as
templated rather than considered. Three of its habits went with it, and should not come
back: tracked-out ALL-CAPS section labels, meta strings joined with middle dots, and a
hairline rule under every row.

**Color tokens:**
| Token | Value | Use |
|---|---|---|
| Background | `#16171A` | page background |
| Surface | `#232428` | raised chrome — chips, tag pills, score badges, thumbnail placeholder |
| Text primary | `#ECECEE` | titles |
| Text secondary | `#8A8B93` | meta, descriptions, icons |
| Divider | `#232428` | retained for the few edges that still need one; rows no longer use it |
| Accent | `#ECECEE` | not a hue — the ink inverted. Active chip, score, the one tappable link in a panel |
| Accent background | `#16171A` | what sits on top of accent |
| Thumbnail placeholder | `#232428` | |

There is deliberately no accent *hue*. On a dark ground, full-contrast ink does the job a
coloured accent does on a light one, and it leaves the thumbnails as the only saturated
thing in the list.

**Typography:**
- One family, IBM Plex Sans Hebrew, for everything. Hierarchy comes from weight and size,
  not from a second face.
- One family because the list is bilingual. Pairing a Latin family with a Hebrew one behind
  it in the stack renders each script in a face designed for it, but the two never agree on
  weight: Hebrew comes out visibly thinner than Latin at the same `font-weight`, and fixing
  that needs a per-script weight, which no single CSS declaration can express. Plex draws
  both scripts as one system, so a mixed title is one voice and `font-weight: 500` means the
  same thing on either side of it.
- A Hebrew serif was tried for titles (Frank Ruhl Libre) and rejected: at 15px it reads dark
  and cramped, and Hebrew publishing doesn't lean on serifs at UI sizes the way Latin does.
- Titles: 15.5px / 500, tracking -0.011em. Meta: 12px. Section names: 12.5px / 500, sentence
  case.
- Titles and body text carry `dir="auto"`, which takes the direction from the string's own
  first strong character — per string, because the list is mixed. Alignment is pinned left
  regardless, so an RTL title stays with its thumbnail instead of drifting to the far edge
  while the meta line under it stays put; only the ordering inside the line flips.

**Layout:**
- Dense list rows, left-aligned. No card wrapper, no shadows, no rounded-card-grid treatment.
- Rows are separated by space, not by a rule. 46px thumbnails at 9px radius; chips and tag
  pills share that radius family so the chrome reads as one set of shapes.
- A row's tag is a pill rather than a word after a middle dot — the shape says "category"
  without spending a separator glyph on saying it. Row *state* ("adding details", "couldn't
  fetch details") stays plain text, because it isn't a category.
- Filter bar: horizontal scrollable tag chips at the top (`all`, `shopping`, `watch`, `recipe`, ...). Active chip filled with the accent color; inactive chips are outlined/muted.

### 4.2 Row anatomy (collapsed — default state for every link type, including movies/TV)

```
[thumbnail]  Title (serif, 15px)  [score badge if scored]     [WA icon] [chevron]
             domain · tag (sans, 12px, secondary/accent)
```

- Thumbnail: 40x40px, 6px radius, placeholder fill until a real image loads.
- Score badge (watch-tagged links, and read-tagged books): small pill, accent-tinted background, star icon + number, sits inline next to the title — the *only* way a scored row differs from others at rest. A movie/TV row's number is the IMDb rating; a book's is the reassurance score (§3.3). No description or trailer link is visible until expanded.
- Action column (right side, always two icons, no overflow/kebab menu): WhatsApp icon (direct tap → builds and opens the wa.me link) and a chevron (direct tap → toggles the expand panel). Both are independent, single-purpose taps — no intermediate menu for either.

### 4.3 Row interactions

- **Tapping the row body** (thumbnail + title + meta area) opens the original URL directly — this is the primary action, since the whole point of the app is getting back to the link.
- **Tapping the chevron** expands/collapses an inline panel below the row showing: the user's note (if any), and for `watch`-tagged links, the description and a trailer link. This does not navigate away. Several panels may be open at once — auto-closing the last one turned comparing two rows into a memory game, and a panel is a short paragraph, so the cost of leaving them open is small. A "collapse all" control above the list is the way back (§4.6).
- **Tapping the WhatsApp icon** builds and opens the wa.me share link for that row. Independent of the chevron and the row-body tap — none of the three should trigger each other (`stopPropagation` on both icon taps).
- **Swipe-to-archive/remove** — flagged as the app's second signature gesture but not yet fully speced (see Open Questions). Needs a real gesture library (Framer Motion) in the actual build; a static mockup can't demonstrate it properly.

### 4.4 Motion principles

- One deliberate interaction per surface rather than scattered hover/entrance effects everywhere (no fade-and-slide-up on every row load).
- The expand panel eases open/closed (height transition), chevron rotates 180° in sync.
- The swipe gesture (once speced) should use spring/overshoot easing, not linear/CSS-ease, to feel physical rather than mechanical.

### 4.5 Content/copy guidelines

- Sentence case everywhere, no ALL CAPS labels.
- Titles are the page's own title with the site chrome cut off ("… | Store Name"), so a
  Hebrew page stays in Hebrew. The LLM only names a row when the scrape came back with
  nothing usable — a blocked site, a bot interstitial, or a bare site name.
- Tag chip labels are lowercase single words (`shopping`, `watch`, `recipe`).

### 4.6 Sections and the collapse-all control

On the `all` tab the list is grouped into collapsible sections, one per core tag, plus
"everything else". Rows still enriching get a pinned section on top that does not collapse —
it empties itself as enrichment finishes, and the row you just shared is the worst one to
bury at the bottom.

- A single right-aligned text button sits above the sections and reads **Collapse all**, or
  **Expand all** once there is nothing left open. It closes every collapsible section *and*
  every open row panel, because collapsing the list and leaving a panel hanging open would
  read as a bug rather than a distinction.
- Expand all restores the sections only. Row panels are closed by default and hold a
  paragraph each, so throwing all of them open is not what it is asking for — it means put
  the list back the way it starts.
- The control is tied to the sections existing, not to there being something to close, so it
  holds its place instead of shoving the list down the moment a panel opens.
- A search forces every section open, so a hit cannot hide inside a shut one; that leaves the
  control nothing to do and it is not shown.

---

## 5. V2 — nice to have: screenshots

Not part of the initial build. Saving a screenshot (e.g. from Instagram, a text thread, a photo of a menu) alongside links.

### 5.1 Storage problem and fix

iPhone screenshots run ~1–4MB each (full-resolution PNG). Supabase's free storage tier is 1GB total — at that size, only 300–500 screenshots before running out, competing with the same bucket as any link thumbnails. Fix, both parts:
- **Compress + downscale on upload**: convert to WebP/JPEG at ~80% quality, cap the longest dimension to ~1200–1600px. Not for printing, just reference — this cuts file size 70–85% with no meaningful quality loss for that purpose.
- **Separate image storage from Supabase**: use Cloudflare R2 (10GB free, no egress fees) or Cloudinary (~25GB free, with automatic format/quality optimization at delivery). Supabase stays for the `links` table only; images live elsewhere so one doesn't crowd out the other.

### 5.2 Content analysis

Gemini's free tier is multimodal — it accepts an image directly alongside a text prompt, same pipeline already used for link tagging (section 3.3, step 3), just with the screenshot instead of scraped OG data. Ask for OCR'd text, a short description, and tags, same JSON shape.

Quota check at expected volume (~3 links + 1–2 screenshots/day): free-tier Flash allows roughly 500–1,500 requests/day depending on variant — this usage is under 1% of even the tightest tier. The limit that could actually matter is **per-minute** (10–15 requests/minute), only relevant if many items get saved in the same minute (e.g. a bulk import), not at normal daily pace. Image calls do cost more tokens per request than text-only ones, worth knowing but not a real constraint at this volume.

### 5.3 Data model addition

Add to the `links` table (or reuse it — same table, a `type` column distinguishing `link` vs `screenshot`):
- `type`: `'link' | 'screenshot'`
- `extracted_text`: the OCR/description output for screenshots
- `image_url` (already in the schema) points at the compressed screenshot instead of a scraped thumbnail

### 5.4 Capture flow

Same iOS Shortcut mechanism as links — the share sheet entry accepts an image instead of a URL, POSTs the image (or uploads it directly to R2/Cloudinary and POSTs the resulting URL) to the backend, which runs it through the Gemini vision call.

### 5.5 Row design — differs from link rows

A screenshot has no external URL to open, so the interaction model changes:
- **No chevron control, and no row-body link-out.** The whole row body is the expand/collapse toggle (there's nothing else for a tap to do, since there's no link to open). A chevron icon still renders for visual affordance and rotates in sync, but any tap on the row (outside the WhatsApp icon and, once expanded, the thumbnail) toggles the panel.
- **Expanded state** shows the extracted text/description plus a small (~56px) thumbnail of the screenshot.
- **Tapping the small thumbnail** opens the image full-screen: a darkened backdrop (`rgba(20,16,10,0.82)` over the current screen, not a route change) with the image centered, dismissible by tapping the backdrop or a close (×) control.

### 5.6 Sharing a screenshot to WhatsApp — different mechanism than links

`wa.me` can only pre-fill text; it cannot attach a file, so it works for links (title + URL) but not for the image itself. Sharing the actual image requires the **Web Share API** (`navigator.share` with a `files` array), supported in iOS Safari since iOS 15:

```js
const blob = await fetch(imageUrl).then(r => r.blob());
const file = new File([blob], 'screenshot.jpg', { type: blob.type });
if (navigator.canShare({ files: [file] })) {
  await navigator.share({ files: [file] }); // leave title/text empty
}
```

This opens the **general OS share sheet** (not a direct jump into WhatsApp) — WhatsApp is one of the destinations in it, alongside Messages, Mail, AirDrop, etc. That's one more tap than the direct `wa.me` link gives on link rows, and it's an inherent limitation, not a bug to fix later.

One iOS-specific quirk: passing a non-empty `title` alongside `files` has been reported to make some share targets — WhatsApp specifically — fall back to sharing as text instead of the actual file. Leave `title` and `text` empty when sharing a file.

**Still undecided**: whether the share icon on screenshot rows should still be WhatsApp-branded (since it's still the most likely destination) or a generic share icon (to be honest that it opens a picker, not WhatsApp directly) — flag to the user before finalizing.

---

## 6. Open questions (not yet decided — flag to the user before finalizing)

1. **Tag vocabulary**: exact fixed list + how much freeform tagging latitude to give the model.
2. **Swipe-to-archive/remove**: full interaction spec — swipe direction, reveal threshold, whether it's destructive-immediate or shows an undo toast.
3. **Empty state**: copy and visual treatment when the list has no links yet, or a filter returns nothing.
4. **Search behavior**: not yet designed — how search should match (title/domain/tags/note) and where the search field lives in the layout.
5. **PWA vs. plain bookmarked site**: whether the frontend should be a proper installable PWA (home screen icon) or just a bookmarked page — affects manifest/service worker setup.
6. **Screenshot share icon**: WhatsApp-branded or generic share icon (see 5.6).
7. **Gemini fallback for non-text screenshots**: not yet designed — what happens when a screenshot has little/no extractable text (a plain photo rather than a text-heavy capture).

---

## 7. Accompanying frontend code

Code implementing section 4 ships alongside this spec, in `frontend/`:

- `tokens.css` — the color/font tokens from 4.1 as CSS custom properties.
- `Icons.jsx` — inline SVG chevron/star/WhatsApp icons (no external icon package dependency).
- `LinkRow.jsx` — a single row: row-body link-out, chevron-driven expand panel (height measured via `scrollHeight`, no fixed max-height guess), direct WhatsApp button building the `wa.me` link client-side. Matches 4.2–4.4 exactly, including that WhatsApp and chevron taps `stopPropagation` so neither triggers the row's link-out, and that the chevron slot stays reserved (invisible, not removed) on rows with nothing to expand so the WhatsApp icon's position never shifts.
- `LinkList.jsx` — the filter chip bar (derives available tags from the data, no hardcoded list) plus the row list.
- `App.jsx` — wires it together with sample data shaped like what the Supabase `links` table (section 3.2) would return. Replace the sample array with a real Supabase fetch once the backend is live.
- `mock.html` — a single-file, no-build-step, runnable HTML reference implementing the full design end to end: mixed link rows (shopping/watch/recipe) collapsed by default, the score badge, chevron expand, direct WhatsApp buttons, and (added for v2 reference) a screenshot row with whole-row-toggle expand and the full-screen darkened image viewer from section 5.5. Open it directly in a browser — no dependencies beyond a Google Fonts import.

Not yet implemented in code (tracked in Open Questions above): swipe-to-archive, empty state, search, whichever tag vocabulary gets finalized, and the real Web Share API screenshot-sharing call (the mock demonstrates the interaction pattern with placeholder images, not a live Gemini/R2 pipeline).

## 8. Summary of key decisions log

- Web app, not iOS native. App name: **Junk Drawer**.
- Capture via iOS Shortcut (Safari can't be a native share target) — domain-based branch for Instagram-only optional note prompt.
- Supabase for data, free-tier serverless functions for the capture/enrichment endpoint, yt-dlp hosted separately from lightweight edge functions.
- Gemini Flash (free tier) for tagging/title/summary generation, using the user's note as primary signal when present. Confirmed free-tier quota is far beyond expected volume (~3 links + 1–2 screenshots/day).
- TMDb + OMDb chained for movie/TV enrichment (description + trailer from TMDb, IMDb rating specifically from OMDb via TMDb's imdb_id).
- WhatsApp share for links is a client-side `wa.me` link — no backend or API key involved. For screenshots, sharing the actual image requires the Web Share API instead (see 5.6) — a different mechanism, one extra tap, not unifiable with `wa.me`.
- Visual direction: ink — dark neutral ground, one bilingual sans, no accent hue, dense list rows
  (not cards/grid). Replaced a warm-cream/serif/terracotta treatment that read as templated.
- All link types collapsed by default, including movies/TV — score badge is the only rest-state difference. Books get the same badge, scored by taste rather than looked up (§3.3).
- Row body opens the link; chevron expands details; WhatsApp is a direct button — no kebab/overflow menu anywhere in the row.
- Row titles come from the page itself, not the model. The scrape's title with the site chrome cut off keeps a Hebrew page in Hebrew; Gemini only names a row when the scrape was unusable, and still owns tags and the summary either way.
- One type family (IBM Plex Sans Hebrew) covers both scripts, so Hebrew and Latin match in weight by
  construction rather than by tuning. Two-family stacks were tried twice and both times the scripts
  disagreed on weight. Text carries `dir="auto"` for ordering, with alignment pinned left.
- Swipe-to-archive sets `draggable={false}` on every link and image in a row and swallows the click
  that follows a drag. Without the first the browser's native link drag eats the gesture; without the
  second the release opens the link you just archived.
- A stored favicon is never shown as a thumbnail. At 40px it reads as clutter, so those rows get the derived monogram tile and the list keeps one solid left edge.
- Several row panels may be open at once, and one "collapse all" control closes them along with every section.
- v2 (nice to have): screenshot saving, with its own storage strategy (compression + separate free image storage) and its own row interaction model (whole-row toggle instead of link-out, full-screen image viewer).
