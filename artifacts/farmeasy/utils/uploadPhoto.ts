import { customFetch } from "@workspace/api-client-react";

/**
 * Upload a local photo and return the STORED reference for it.
 *
 * Task 11: the API now returns `{ key, url }`. We return `key` (the
 * bucket-relative object key, e.g. "media/a1b2c3d4.jpg") — NOT `url` —
 * because a signed URL expires in ~1h, and what gets stored as the
 * permanent photo reference (and later re-signed on read) must be the
 * stable key. Callers collect the returned string into a `photoUrls`
 * array and submit it when creating a record.
 */
export async function uploadPhoto(localUri: string): Promise<string> {
  const formData = new FormData();
  formData.append("file", {
    uri: localUri,
    type: "image/jpeg",
    name: "photo.jpg",
  } as any);

  const { key } = await customFetch<{ key: string; url: string }>(
    "/api/media/upload",
    {
      method: "POST",
      body: formData as any,
    },
  );

  return key;
}
