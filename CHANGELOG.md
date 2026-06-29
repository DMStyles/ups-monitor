# Changelog

## v2.0.4 — Real-Time Cloud Sync Tracking (2026-06-29)

### 🚀 Features & Fixes
- **Real-time Sync Time**: Integrated active timestamp updates in the background worker. The settings page cloud account card now displays the actual last sync completion time dynamically rather than a stale login timestamp.

---

## v2.0.3 — Profile Picture Fallback & Referrer Fix (2026-06-29)

### 🐛 Fixes
- **Google Profile Image:** Added `referrerpolicy="no-referrer"` to the profile picture image tag. This bypasses Google's request blocks on embedded WebView2 contexts, allowing the profile image to load normally.
- **Premium Fallback Avatar:** Added a circular CSS gradient fallback. If Google's profile image server is slow or fails to load, the app now automatically hides the broken icon and displays the first letter of your name ("D" for Dilshan) inside a clean, modern color gradient circle.

---

## v2.0.2 — Unicode Encoding & Layout Fixes (2026-06-29)

### 🐛 Fixes
- **Encoding Issues:** Replaced all Unicode en-dash (`–`) and multiplication (`×`) characters with HTML entities (`&times;`) and standard ASCII characters (`-`). They will now render correctly under all configurations without encoding mangling (e.g. fixing the garbled `Ãfâ€”` text in the CEB Bill Estimator).
- **Context Menu:** Blocked the default browser right-click context menu inside the WebView2 container completely.

---

## v2.0.1 — Cloud Flow & Layout Cleanup (2026-06-28)

### 🐛 Fixes
- **Settings Card Auto-Update:** The profile card now detects the active session and switches from "Waiting for sign-in..." to your profile (name, email, avatar) automatically.
- **Header Button Sync:** Both the header "Cloud Synced" button and the Settings card "Sign in with Google" button reset properly on sign-out.

---

## v2.0.0 — Cloud Sync & Profile Update (2026-06-28)

### ✨ New Features
- **Cloud Sync via Supabase** — Sign in with Google to sync your energy data, outage history, and settings across devices
- **Cloud Account panel in Settings** — Shows your Google profile picture, name and email once signed in, with a Last Sync timestamp and Sign Out button
- **Settings auto-sync to cloud** — Every time you save settings they are pushed to your Supabase account in the background
- **Native OAuth flow** — Login opens in your default browser (Chrome / Edge / Firefox) instead of inside the embedded WebView, which is blocked by Google. After sign-in, the app is authorised automatically
- **Sign Out button** — Clears session from both the backend and the header button

### 🐛 Fixes
- **Version number in About** now shows the correct live version from the backend API (was hardcoded `v1.3.0`)
- **"Mute Alarm" button emoji** was rendering as garbled characters (UTF-8/Latin-1 double-encode); replaced with safe Unicode escapes
- **Bullet separator in subtitle** was rendering as `Ã¢â‚¬Â¢`; replaced with `&bull;` HTML entity
- **Dashboard stuck on "Connecting…"** — Root cause was the Supabase CDN `<script>` tag loaded in `<head>` without `async/defer`, blocking the entire page in WebView2. Fixed by moving it to end of `<body>` as async, then removing it entirely once the backend OAuth flow replaced the need for it
- **app.js corruption** from prior bad patches fully resolved — file rewritten cleanly with verified `node -c` syntax check

### ⚙️ Backend
- Added `/api/cloud/login` — opens the system browser to Supabase Google OAuth
- Added `/api/oauth/callback` — local loopback page that captures the access token and sends it to the running backend
- Added `/api/cloud_user` — returns `{signed_in, name, email, avatar_url}` for the Settings profile card
- Added `/api/cloud_signout` — clears the Supabase session from the backend
- Added `/api/open_browser` — generic endpoint to open any `https://` URL in the default system browser
- Settings save now triggers a background cloud sync thread if signed in
- `supabase_sync.py` extended with `user_name`, `user_email`, `user_avatar` fields and `sync_settings_to_cloud()` / `sign_out_supabase()` helpers
