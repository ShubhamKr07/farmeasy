import { Router, type Request, type Response, type NextFunction } from "express";
import { getAuth, supabaseAdmin } from "../middlewares/supabaseAuth";
import multer from "multer";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { signMediaReferences } from "../services/mediaUrls";

const MEDIA_BUCKET = "media";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed"));
      return;
    }
    cb(null, true);
  },
});

function enforceAuth(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const router = Router();

router.post("/media/upload", enforceAuth, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided" });
  }

  const ext = path.extname(req.file.originalname) || ".jpg";
  // Task 11 Step 3: store every object under the `media/` folder (the bucket
  // name doubles as the folder convention) so the same key is what gets signed
  // back on read. `key` is the permanent photo reference; `url` below is a
  // short-lived signed URL for immediate display.
  const key = `media/${randomBytes(8).toString("hex")}${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(MEDIA_BUCKET)
    .upload(key, req.file.buffer, { contentType: req.file.mimetype });

  if (error) {
    req.log.error({ err: error }, "supabase storage upload failed");
    return res.status(502).json({ error: "Upload failed" });
  }

  // Sign the freshly-stored key so the uploader can immediately display the
  // photo. signMediaReferences throws (never partial) on any signing failure —
  // surface it as a 502, mirroring the upload-error path above (storage-error
  // convention).
  let url: string;
  try {
    [url] = await signMediaReferences([key]);
  } catch (err) {
    req.log.error({ err }, "failed to sign uploaded media reference");
    return res.status(502).json({ error: "Upload failed" });
  }

  return res.json({ key, url });
});

export default router;
