// DEPRECATED — the ImgBB API key used to live here, in plain frontend JS,
// where anyone could open dev tools and copy it. It has moved to the
// BACKEND (backend/.env -> IMGBB_API_KEY), which now proxies uploads via
// POST /api/uploads/image (see routes/uploads.py). image-upload.js no
// longer imports anything from this file.
//
// This file is kept only so nothing breaks if something old still
// references it. Safe to delete once you've confirmed nothing does.
