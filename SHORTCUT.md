# The iOS Shortcut

Safari can't be a Web Share Target (spec §2.1), so capture goes through a
Shortcut in the share sheet.

Its one clever part: it grabs the product photo **from the page already rendered
on your phone**. Large retailers block server-side scraping outright — Zara
serves an Akamai interstitial, Amazon, Etsy, H&M and Argos return 403 — so the
server can never see the item image. Your browser already has it.

## Endpoint

```
POST https://junkdrawer-alpha.vercel.app/api/capture
Authorization: Bearer <CAPTURE_TOKEN>
```

`junkdrawer-alpha.vercel.app` is the stable production alias. Don't point the
Shortcut at a `junkdrawer-<hash>-dt-9372.vercel.app` deployment URL — those are
per-deploy and stop being current the next time you ship.

Either `application/json` with `{ url, note }`, or `multipart/form-data` with
`url`, `note` and `image`. Use multipart when there's a photo.

## Building it

New Shortcut → rename it "Junk Drawer" → ⓘ → **Show in Share Sheet** on, accepted
input **URLs and Safari web pages**.

1. **Receive** *URLs and Safari web pages* from Share Sheet.

2. **If** *Shortcut Input* *contains* `instagram.com`
   - **Ask for Input** — Text, prompt "Note?", **Allow empty**. Instagram blocks
     scraping hardest, so your one line is the only real signal there.
   - **Otherwise** → Text with nothing in it.
   - **End If** → **Set Variable** `note`.

3. **Run JavaScript on Web Page** — this is the step that beats bot blocking.
   It runs in the page you're looking at, with your session and your IP.

   ⚠️ Set its **input** to *Shortcut Input* explicitly. It defaults to the
   previous action's output, which is `note` — it would run against a string
   instead of the page and return empty with no error.

   It reads the four meta tags the page already declares and hands them over
   as text. It does not try to *pick* an image — an earlier version scored
   every `<img>` on the page by area, srcset width and aspect ratio while
   dodging "you may also like" strips, and that was fifty lines of heuristic
   living in a phone GUI, untestable except by sharing pages on a phone, whose
   failure mode was a plausible photo of the wrong thing. The page already
   says which image is the item's. Believe it.

   ```javascript
   const m = p => document.querySelector(`meta[property="${p}"]`)?.content || "";
   completion(JSON.stringify({
     title: m("og:title"),
     description: m("og:description"),
     image: m("og:image"),
     site: m("og:site_name"),
   }));
   ```

   **Set Variable** `page`.

4. **Get Contents of** `https://junkdrawer-alpha.vercel.app/api/capture`
   - Method **POST**
   - Headers: `Authorization` = `Bearer <CAPTURE_TOKEN>`
   - Request Body **Form**:
     - `url` → *Shortcut Input* (as URL)
     - `note` → `note`
     - `page` → `page`

5. Optional: **Show Notification** "Saved" so the share sheet confirms.

### The image branch

Sharing a photo goes to a different endpoint, so the shortcut branches on
whether the input yielded a URL — an image yields none.

```
Get URLs from Shortcut Input
If  URLs  has any value          ← everything above
Otherwise
    Resize Image   Shortcut Input, width 1200 (height auto)
    Convert Image  to JPEG
    Get Contents of  …/api/capture/screenshot
        POST · same Authorization header · Form · image → Converted Image
End If
```

**Convert Image is load-bearing here and only here.** `ALLOWED_IMAGE_TYPES` in
`lib/capture.ts` is jpeg, png and webp, iOS hands you HEIC, and Resize keeps
whatever format it was given. Measured against production: JPEG `201`, HEIC
`400 Unsupported image type: image/heic`.

Unlike the link branch this one really does send multipart, because a file is
present — so it can't hit the urlencoded problem that the link branch did.

There is no image step. The phone sends the image *URL* inside `page` and the
server fetches the picture itself, which is why there is nothing here to
download, resize or convert — and no `400 Unsupported image type: image/heic`
waiting for you, since `ALLOWED_IMAGE_TYPES` never sees an iOS photo.

Retailers bot-block their page HTML and not their image CDNs. Measured from
one machine, same UA for both columns:

| | page HTML | image CDN |
|---|---|---|
| etsy | 403 | 404 |
| hm | 403 | 410 |
| amazon | 200 | 200 |

The 404 and 410 are invented paths — the point is that the CDN *answered*
rather than serving an interstitial. So a URL the phone read off the page is
enough; the bytes do not have to make the trip.

The `image` form field still exists and still takes a file, for the screenshot
path and for anything that needs to push actual pixels. It just isn't how link
capture works any more.

## Keeping it in the repo

The shortcut is the one part of capture that lives outside the codebase: built
in a GUI, no diff, nothing to review, and reinstalling it means rebuilding it
by hand. So `shortcuts/capture-web-page.plist` is the source of truth and the
phone holds a copy.

```bash
npm run shortcut     # inject the token, sign, output to shortcuts/dist/
```

AirDrop the signed file to your phone, or open it on a Mac signed into the
same account.

**The committed plist has no token in it.** An exported shortcut carries the
Authorization header verbatim, and this repo is public, so committing an
export would republish the secret — the same mistake that burned the last
token. The committed copy holds `__CAPTURE_TOKEN__`, the build injects the
real value from `.env.local`, and `shortcuts/dist/` is gitignored. The build
refuses to run if the placeholder is missing, which is what stops a build
output being committed over the source.

To pull changes back after editing on the phone: share the shortcut to iCloud,
then

```bash
curl -s https://www.icloud.com/shortcuts/api/records/<id> \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['fields']['shortcut']['value']['downloadURL'])" \
  | xargs curl -sL -o /tmp/s.shortcut
plutil -convert xml1 /tmp/s.shortcut -o -   # readable; redact the token before committing
```

An iCloud-shared shortcut downloads as a plain binary plist. A shortcut
exported straight from the app is an AEA archive and cannot be read back, so
iCloud is the route that round-trips.

## Your token

Read it out of `.env.local`, which is gitignored:

```bash
grep '^CAPTURE_TOKEN=' .env.local | cut -d= -f2
```

Paste that into the Shortcut's `Authorization` header, and set the same value
as `CAPTURE_TOKEN` in the deployment's environment variables.

**Never write the value into this file.** It used to live here in plaintext,
and this repo is public — so that token is burned and has been rotated. A
secret in a committed doc is a secret published. To rotate: generate a new
value, update `.env.local` and the deployment together, then re-paste it into
the Shortcut.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Checking it works

Three tests, increasing in fidelity. Each isolates a different half, so run
them in order — a failure at the phone stage means something different
depending on whether the server stage passed.

### 1. The server half, no phone needed

```bash
curl -X POST http://localhost:3000/api/capture \
  -H "Authorization: Bearer $(grep '^CAPTURE_TOKEN=' .env.local | cut -d= -f2)" \
  -F "url=https://example.com/thing" \
  -F "note=testing" \
  -F "image=@photo.jpg;type=image/jpeg"
```

Swap the host for `https://junkdrawer-alpha.vercel.app` to test the deployment
the phone will actually talk to — worth doing after any env var change, since
Vercel snapshots those at deploy time and a stale token only shows up as a 401.

Expect `201 {"id":"…","saved":true}` in well under a second. Enrichment runs
afterwards, so the row appears immediately and fills in a few seconds later.

Then check the row stored a reference rather than a URL: `image_kind` should be
`photo` and `image_url` should begin `storage:items/`. Anything starting
`https://` means the image is being hot-linked, which is the thing
`lib/enrich.ts` is written to avoid.

### 2. The JavaScript step alone, on the phone

The highest-value test, because it is the part that beats bot-blocking.
Temporarily add a **Quick Look** of `page` immediately after the Run JavaScript
step, share a real product page from Safari, and read the JSON *before*
anything is posted. Remove the Quick Look when you're done.

What you want to see is four non-empty fields. An empty `title` means the
JavaScript ran against the wrong input — check step 3's input is *Shortcut
Input*. Empty everything means the page declares no og: tags at all, which is
rare on a retailer and is the case where the server's own scrape is still the
fallback.

### 3. The whole path

Quick Look removed, share from Safari, watch the row appear in the list and
fill in. That's the feature working.

**Testing the extraction from a laptop doesn't substitute for step 2.** Zara
answers `Access Denied` to a real desktop Chrome from a home or office IP, let
alone a datacentre one — which is the entire reason this runs on your phone.
You can develop the selector logic against pages that *do* load (`agent-browser
open <url>` then `agent-browser eval`), but only the phone tells you about the
sites that matter.

## Notes

- **Run JavaScript on Web Page only works on a Safari web page**, not a bare URL.
  Sharing a link from Messages skips step 3 and the row falls back to a favicon.
- Step 3 will ask permission the first time.
- No image is not a failure. The row still gets a title, summary and tags, and
  falls back to a tile derived from the domain. A favicon is still fetched and
  stored, but deliberately never rendered as a thumbnail — at 40px it reads as
  clutter (see `LinkRow.tsx`), so the tile is what you'll actually see.
