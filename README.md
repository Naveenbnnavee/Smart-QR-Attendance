# Smart QR & Geo-Fenced Verification Engine

[![Category](https://img.shields.io/badge/Category-Full--Stack%20Security%20%26%20Enterprise-emerald)](https://github.com)
[![Stack](https://img.shields.io/badge/Stack-Node.js%20%7C%20Express%20%7C%20MongoDB-green)](https://github.com)
[![Verification](https://img.shields.io/badge/Security-Anti--Proxy%20Triple%20Validation-cyan)](https://github.com)

Enterprise identity and attendance verification platform featuring rotating cryptographic tokens, spatial geo-fencing polygon validation, and anti-proxy device fingerprint binding.

---

## 🎯 Key Engineering Metrics

- **5s Temporal QR Rotation:** Dynamic nonces cryptographically signed with short TTL, neutralizing screenshot sharing and proxy attacks.
- **10-Meter Geo-Fencing Precision:** High-precision Haversine distance bounding ensuring physical attendance on-site.
- **1:1 Hardware Fingerprint Binding:** Canvas, screen dimension, and WebGL signature hashing preventing multi-account scans on a single device.
- **Low-Latency Verification Loop:** Sub-100ms request validation cycle with atomic MongoDB nonce recording.

---

## 🏗️ System Architecture & Anti-Proxy Invariants

```
[ Lecturer Dynamic Display ] ➔ Generates Signed Token every 5 seconds
        │
        ▼ (Physical Scan)
[ Student Smartphone Browser ]
        ├── Captures HTML5 High-Accuracy Geolocation (Latitude, Longitude)
        └── Computes Client Hardware Fingerprint Hash
        │
        ▼ (POST /verify)
[ Express.js Verification Pipeline ]
        ├── 1. Nonce Validity & Time-Drift Window Check (< 5s TTL)
        ├── 2. Haversine Spatial Bounding Verification (< 10m threshold)
        └── 3. Device Binding Hash Verification (Single Active Session)
        │
        ▼ (Passed)
[ Atomic Attendance Record Written to MongoDB & SMS Notification via Twilio ]
```

---

## 🚀 Quickstart & Local Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
Create a `.env` file:
```env
PORT=3000
MONGO_URI=mongodb://localhost:27017/qrAttendanceDB
SESSION_SECRET=your_super_secret_session_key
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_PHONE_NUMBER=your_twilio_phone
```

### 3. Run the Server
```bash
npm start
```

- **Student / Lecturer Portal:** `http://localhost:3000`
- **Architectural Showcase Page:** View `showcase.html` in your browser.
