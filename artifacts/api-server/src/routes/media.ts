import { Router, type Request, type Response, type NextFunction } from "express";
import { getAuth, supabaseAdmin } from "../middlewares/supabaseAuth";
import multer from "multer";
import path from "node:path";
import { randomBytes } from "node:crypto";

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
  const filename = `${randomBytes(8).toString("hex")}${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(MEDIA_BUCKET)
    .upload(filename, req.file.buffer, { contentType: req.file.mimetype });

  if (error) {
    return res.status(502).json({ error: "Upload failed" });
  }

  const { data } = supabaseAdmin.storage.from(MEDIA_BUCKET).getPublicUrl(filename);
  return res.json({ url: data.publicUrl });
});

export default router;
