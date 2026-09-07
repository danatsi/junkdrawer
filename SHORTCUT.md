# The iOS Shortcut

Safari can't be a Web Share Target (spec §2.1), so capture goes through a
Shortcut in the share sheet.

Its one clever part: it grabs the product photo **from the page already rendered
on your phone**. Large retailers block server-side scraping outright — Zara
serves an Akamai interstitial, Amazon, Etsy, H&M and Argos return 403 — so the
server can never see the item image. Your browser already has it.

## Endpoint

```
POST https://<your-app>/api/capture
Authorization: Bearer <CAPTURE_TOKEN>
```

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

   ```javascript
   // Best available product image, largest first, ignoring sprites and logos.
   const meta = document.querySelector('meta[property="og:image"]')?.content;
   let best = meta && !/logo|sprite|placeholder/i.test(meta) ? meta : null;
   if (!best) {
     const imgs = [...document.images]
       .filter(i => i.naturalWidth > 200 && i.naturalHeight > 200)
       .filter(i => !/logo|sprite|icon|placeholder/i.test(i.src))
       .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
     best = imgs[0]?.src ?? null;
   }
   completion(best || "");
   ```

   **Set Variable** `imageUrl`.

4. **If** `imageUrl` *has any value*
   - **Get Contents of** `imageUrl` → **Set Variable** `photo`
   - **Resize Image** `photo` to **800** px wide (keeps the upload small; the
     server rejects anything over 5MB)
   - **End If**

5. **Get Contents of** `https://<your-app>/api/capture`
   - Method **POST**
   - Headers: `Authorization` = `Bearer <CAPTURE_TOKEN>`
   - Request Body **Form**:
     - `url` → *Shortcut Input* (as URL)
     - `note` → `note`
     - `image` → the resized `photo` *(omit this field when there's no image —
       the endpoint accepts plain JSON too)*

6. Optional: **Show Notification** "Saved" so the share sheet confirms.

## Your token

```
73ca4e669f0ef26d57afa12c4a474afa14fae94eeee770fef53d8d17cab9062c
```

Same value as `CAPTURE_TOKEN` in `.env.local`. Rotate it there and here together.

## Checking it works

```bash
curl -X POST https://<your-app>/api/capture \
  -H "Authorization: Bearer $CAPTURE_TOKEN" \
  -F "url=https://example.com/thing" \
  -F "note=testing" \
  -F "image=@photo.jpg;type=image/jpeg"
```

Expect `201 {"id":"…","saved":true}` in well under a second. Enrichment runs
afterwards, so the row appears immediately and fills in a few seconds later.

## Notes

- **Run JavaScript on Web Page only works on a Safari web page**, not a bare URL.
  Sharing a link from Messages skips step 3 and the row falls back to a favicon.
- Step 3 will ask permission the first time.
- No image is not a failure. The row still gets a title, summary and tags, and
  falls back to the site's favicon, then to a generated tile.
