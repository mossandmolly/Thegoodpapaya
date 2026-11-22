// Supabase Edge Function — backfill-compress-catalog-images
//
// One-off manual tool, NOT on a cron — trigger it yourself with curl (see
// bottom of this file), re-running it until it reports remaining: 0.
//
// ops-dashboard/parser.html's catalog photo upload used to store phone
// camera photos at full size (often several MB, thousands of pixels
// wide) — fixed going forward, but every photo uploaded BEFORE that fix
// is still sitting in the catalog-images bucket at full size, which is
// why some item photos load noticeably slower than others on the
// storefront. This function re-encodes those existing photos in place:
// downloads each catalog item's current image, skips it if it's already
// small (nothing to do — makes this safe to re-run), otherwise resizes
// to the same cap the upload path now uses (max 800px, JPEG quality 82)
// and re-uploads it to the exact same storage path, then updates
// catalog.image_url with a fresh cache-busting URL.
//
// Browsers have Canvas/Image APIs to do this resize — a Deno edge
// function doesn't, hence ImageScript (pure WASM, no native deps, the
// standard way to do this in Supabase Edge Functions).
//
// Bounded to BATCH_SIZE items per call so one run can't exceed the edge
// function's execution time limit — call it again to keep going.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Image } from 'https://deno.land/x/imagescript@1.2.17/mod.ts';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-cron-secret',
};

const BUCKET          = 'catalog-images';
const MAX_DIM          = 800;
const JPEG_QUALITY     = 82;
const SKIP_IF_UNDER_BYTES = 250_000; // already small enough — leave it alone
const BATCH_SIZE       = 15;         // per invocation, to stay well inside the time limit

function storagePathFromPublicUrl(url: string): string | null {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + marker.length).split('?')[0]);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const secret = req.headers.get('x-cron-secret') || '';
    if (secret !== env('CRON_SECRET')) throw new Error('Not authorized');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { data: rows, error: selErr } = await supabase
      .from('catalog').select('item_name, image_url')
      .not('image_url', 'is', null)
      .order('item_name');
    if (selErr) throw new Error(selErr.message);

    const candidates = (rows ?? []).filter(r => storagePathFromPublicUrl(r.image_url as string));

    const compressed: string[] = [];
    const alreadySmall: string[] = [];
    const errors: Array<{ item_name: string; error: string }> = [];
    let scanned = 0;

    for (const row of candidates) {
      if (compressed.length >= BATCH_SIZE) break; // leave the rest for the next call
      scanned++;
      const itemName = row.item_name as string;
      const url = row.image_url as string;
      const path = storagePathFromPublicUrl(url)!;

      try {
        // HEAD first — skip the download+decode entirely for anything
        // already small (either a fresh compressed upload, or already
        // handled by an earlier run of this same function).
        const head = await fetch(url, { method: 'HEAD' });
        const len = parseInt(head.headers.get('content-length') || '0', 10);
        if (head.ok && len > 0 && len <= SKIP_IF_UNDER_BYTES) {
          alreadySmall.push(itemName);
          continue;
        }

        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());

        const img = await Image.decode(bytes);
        if (img.width > MAX_DIM || img.height > MAX_DIM) {
          if (img.width >= img.height) img.resize(MAX_DIM, Image.RESIZE_AUTO);
          else img.resize(Image.RESIZE_AUTO, MAX_DIM);
        }
        const jpeg = await img.encodeJPEG(JPEG_QUALITY);

        const { error: upErr } = await supabase.storage.from(BUCKET)
          .upload(path, jpeg, { upsert: true, contentType: 'image/jpeg' });
        if (upErr) throw new Error(upErr.message);

        const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
        const bustedUrl = pub.publicUrl + '?v=' + Date.now();
        const { error: updErr } = await supabase.from('catalog')
          .update({ image_url: bustedUrl }).eq('item_name', itemName);
        if (updErr) throw new Error(updErr.message);

        compressed.push(itemName);
      } catch (e: any) {
        errors.push({ item_name: itemName, error: e.message });
      }
    }

    const remaining = candidates.length - scanned;

    return new Response(
      JSON.stringify({ compressed, alreadySmall, errors, remaining }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});

// To run it: deploy this function, then curl it (reusing the same
// SERVICE_ROLE_KEY/CRON_SECRET you already pulled via the SQL query
// earlier) — repeat until the response says "remaining": 0:
//
// curl -X POST 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/backfill-compress-catalog-images' \
//   -H 'Authorization: Bearer <SERVICE_ROLE_KEY>' \
//   -H 'x-cron-secret: <CRON_SECRET>'
