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

   Picking "the biggest image on the page" is not good enough on a real
   product page: the largest thing is often a "you may also like" tile, and
   the item photo is frequently advertised only in `srcset` while `src` holds
   a thumbnail. So this scores the biggest source each image *offers*, ignores
   page chrome and recommendation strips, and looks inside the product region
   before falling back to the whole document.

   ```javascript
   const BAD = /logo|sprite|icon|placeholder|badge|flag|payment|swatch/i;
   const NOISE = /recommend|related|you-?may|also-?like|complete-?the|carousel|slider|footer|header|\bnav\b|cart|banner|cookie/i;

   const labelOf = el => (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');
   const inNoise = img => {
     for (let el = img; el && el !== document.body; el = el.parentElement) {
       if (NOISE.test(labelOf(el))) return true;
     }
     return false;
   };
   // Largest width the srcset advertises, which src often undersells.
   const srcsetMax = img => {
     const set = img.getAttribute('srcset');
     if (!set) return { width: 0, url: '' };
     const best = set.split(',').map(p => p.trim().split(/\s+/))
       .map(([u, d]) => ({ url: u, width: parseInt(d, 10) || 0 }))
       .sort((a, b) => b.width - a.width)[0];
     return best && best.url ? best : { width: 0, url: '' };
   };
   const area = img => {
     const nw = img.naturalWidth, nh = img.naturalHeight, sw = srcsetMax(img).width;
     return sw > nw && nw > 0 ? sw * (sw * nh / nw) : nw * nh;
   };
   // A banner is wide and short; a product photo isn't.
   const proportionate = img => {
     const nw = img.naturalWidth, nh = img.naturalHeight;
     if (!nw || !nh) return false;
     return (nw > nh ? nw / nh : nh / nw) <= 3;
   };
   const widest = img => {
     const best = srcsetMax(img);
     return best.width > img.naturalWidth && best.url
       ? new URL(best.url, location.href).href
       : (img.currentSrc || img.src);
   };
   const pick = root => [...root.querySelectorAll('img')]
     .filter(i => !BAD.test(i.src) && !inNoise(i))
     .filter(i => proportionate(i) && area(i) > 200 * 200)
     .sort((a, b) => area(b) - area(a))[0];

   const meta = document.querySelector('meta[property="og:image"]')?.content;
   let best = meta && !BAD.test(meta) ? meta : null;
   if (!best) {
     const main = document.querySelector('[itemtype*="Product" i]')
       || document.querySelector('main, #main, [role=main]')
       || document;
     const img = pick(main) || pick(document);
     best = img ? widest(img) : null;
   }
   completion(best ? new URL(best, location.href).href : "");
   ```

   **Set Variable** `imageUrl`.

4. **If** `imageUrl` *has any value*
   - **Get Contents of** `imageUrl` → **Set Variable** `photo`
   - **Resize Image** `photo` to **800** px wide (keeps the upload small; the
     server rejects anything over 5MB)
   - **Convert Image** to **JPEG** → **Set Variable** `photo`
   - **End If**

   The convert step is not optional. `ALLOWED_IMAGE_TYPES` in `lib/capture.ts`
   is jpeg, png and webp only, and Resize Image keeps whatever format it was
   handed — which on iOS is often HEIC. The failure is a `400 Unsupported image
   type: image/heic`, which looks like an auth or endpoint problem until you
   read the body.

5. **Get Contents of** `https://junkdrawer-alpha.vercel.app/api/capture`
   - Method **POST**
   - Headers: `Authorization` = `Bearer <CAPTURE_TOKEN>`
   - Request Body **Form**:
     - `url` → *Shortcut Input* (as URL)
     - `note` → `note`
     - `image` → the resized `photo` *(omit this field when there's no image —
       the endpoint accepts plain JSON too)*

6. Optional: **Show Notification** "Saved" so the share sheet confirms.

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

The highest-value test, because this is both the part that beats bot-blocking
and the part most likely to pick the wrong photo. Temporarily add a **Quick
Look** of `imageUrl` immediately after the Run JavaScript step, share a real
product page from Safari, and look at what it extracted *before* anything is
posted. Remove the Quick Look when you're done.

Worth doing on a few different retailers — the failure mode isn't an error, it's
a plausible-looking photo of the wrong thing.

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
