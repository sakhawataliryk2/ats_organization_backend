# Zoom Phone Integration – Testing Steps

## Prerequisites

- Zoom Server-to-Server OAuth app with Phone scope.
- Environment variables set in `.env`:
  - `ZOOM_ACCOUNT_ID`
  - `ZOOM_CLIENT_ID`
  - `ZOOM_CLIENT_SECRET`
  - `ZOOM_WEBHOOK_SECRET_TOKEN` (for webhook signature verification)
  - Optional: `ZOOM_VERIFICATION_TOKEN` (Bearer token for webhook auth)
  - Optional: `DEFAULT_PHONE_COUNTRY_CODE` (default `1` for US)
- ngrok or another public URL for webhooks (e.g. `https://your-ngrok-url.ngrok.io`).
- Backend and DB running; at least one user and one job seeker (candidate) with a real phone number.

---

## 1. Token and Zoom Phone API

1. Start backend: `npm run dev` (from `cms_organization_backend`).
2. Get a valid JWT (e.g. log in via your frontend or `/api/auth/login`).
3. Call:
   - `GET /api/zoom/phone-users`  
     - Header: `Authorization: Bearer <JWT>`
     - Expect: 200 and Zoom phone users list.
   - `GET /api/zoom/phone-numbers`  
     - Expect: 200 and assigned numbers.
   - `GET /api/zoom/call-logs`  
     - Optional query: `?from=YYYY-MM-DD&to=YYYY-MM-DD`
     - Expect: 200 and call log data.
4. In server logs you should see token usage; on first request or after expiry, “Token refreshed”.

---

## 2. Webhook URL and subscription

1. In Zoom Marketplace, open your Server-to-Server app → Feature → Webhook.
2. Set Event notification endpoint URL to:
   - `https://<your-ngrok-host>/webhooks/zoom`  
   - Or, if you kept the legacy path: `https://<your-ngrok-host>/zoom-webhook`
3. Save; Zoom may send a validation request (`endpoint.url_validation`). Backend should respond with `plainToken` and `encryptedToken`.
4. Subscribe to:
   - `phone.cdr.completed`
   - `phone.sms.received`
   - `phone.sms.sent`
5. Ensure `ZOOM_WEBHOOK_SECRET_TOKEN` matches the secret in the Zoom app (used for HMAC verification).

---

## 3. Click-to-call and call logging (one phone number)

Use one real phone number that you control (e.g. your mobile) as the candidate’s number.

1. **Create a candidate (job seeker)**  
   - In your app or via API, create a job seeker with:
     - `phone` or `mobile_phone` = your test number (e.g. `+15551234567`).

2. **Start a call from the app**  
   - From the job seeker profile, use the “Call” (click-to-call) action.  
   - Frontend should:
     - Call `POST /api/calls/start` with body:  
       `{ "candidateId": "<job_seeker_id>", "phoneNumber": "+15551234567" }`  
       and header: `Authorization: Bearer <JWT>`.
     - Receive response: `{ "dialUrl": "zoomphonecall://call?number=+15551234567" }`.
     - Set `window.location.href = response.dialUrl` to open Zoom and dial.

3. **Backend checks**  
   - In DB, confirm a new row in `pending_calls` with:
     - `candidate_id` = that job seeker id  
     - `phone_number` = normalized number  
     - `status` = `initiated`

4. **Place and end the call**  
   - In Zoom Phone (desktop or app), complete the call to that number and hang up.

5. **Webhook and DB after call end**  
   - Zoom sends `phone.cdr.completed` to your webhook URL.  
   - In server logs you should see:
     - “Zoom webhook received”
     - “Pending call matched” (when callee number matches the pending call)
     - “Candidate call log saved” / “Call logged successfully”
   - In DB:
     - `pending_calls`: that row has `status` = `completed`.
     - `job_seeker_notes`: new note with `note_type` = `call`, content containing Number, Duration, Recruiter (if present), Date.

---

## 4. SMS (optional)

1. Send or receive an SMS using the Zoom Phone number linked to your app.
2. In logs you should see “SMS logged successfully”.
3. If the other party’s number matches a job seeker’s phone/mobile_phone, a note should be created on that candidate.

---

## 5. Edge cases to verify

- **No pending call, but candidate exists**  
  Call a number that is stored on a job seeker but you did **not** start via click-to-call. After `phone.cdr.completed`, a call note should still be created for that job seeker (lookup by phone).
- **No matching candidate**  
  Call a number that is not in `job_seekers`. Logs should show a warning (“No matching job seeker for number”), no crash, webhook responds 200.
- **Invalid webhook signature**  
  Send a POST to `/webhooks/zoom` with a wrong or missing signature. Expect 401.
- **Duplicate webhook**  
  If Zoom retries the same event, the same pending call should only be matched once (first match wins, then `status` = `completed`), so you should not get duplicate notes for the same call.

---

## 6. Quick curl examples (replace placeholders)

```bash
# Token (get JWT from your login flow first)
export JWT="your-jwt-here"
export BASE="http://localhost:8080"

# Zoom Phone API (authenticated)
curl -s -H "Authorization: Bearer $JWT" "$BASE/api/zoom/phone-users"
curl -s -H "Authorization: Bearer $JWT" "$BASE/api/zoom/phone-numbers"
curl -s -H "Authorization: Bearer $JWT" "$BASE/api/zoom/call-logs"

# Click-to-call (creates pending_calls, returns dialUrl)
curl -s -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"candidateId":"1","phoneNumber":"+15551234567"}' "$BASE/api/calls/start"
```

Use the returned `dialUrl` in the browser (or a custom protocol handler) to open Zoom and start the call.

---

## 7. Test without Zoom Phone (simulate webhook)

If you don’t have a paid Zoom Phone account, you can test the full flow by **simulating** a `phone.cdr.completed` webhook.

### Which number to use (callee_number = job seeker)

- **`callee_number`** in the webhook = the person who was **called** (the candidate/job seeker).
- In your app, create (or pick) a **job seeker** and set their **phone** or **mobile_phone** to the number you’ll use in the payload (e.g. `+15551234567`).
- Use that **exact number** as `callee_number` in the simulated webhook so the backend can:
  1. Match a **pending call** (if you clicked “Call” from that job seeker’s profile first), and/or  
  2. Find the **job seeker by phone** and attach the call note to them.

So: **the job seeker’s number in the DB = the number that “picks up” = `callee_number` in the payload.**

### Option A: Postman

1. **Create a job seeker** in the app with phone or mobile = e.g. `+15551234567`.
2. **(Optional)** Open that job seeker’s profile and click **Call** so a row is created in `pending_calls` (then the webhook will match it and mark it completed).
3. **POST** to your webhook URL:
   - **URL:** `http://localhost:8080/webhooks/zoom` (or `https://your-ngrok-url/webhooks/zoom`).
   - **Method:** POST.
   - **Headers:**
     - **Content-Type:** `application/json`
     - **Auth (choose one):**
       - **Quick test (dev only):** Add header **X-Zoom-Test-Webhook:** `allow-insecure`. No token or signature needed. Only works when `NODE_ENV !== "production"`.
       - **Bearer token:** Add to `.env`: `ZOOM_VERIFICATION_TOKEN=my-secret-token`, restart backend. In Postman: **Authorization** → **Bearer Token** → Token: `my-secret-token`.
       - **Script:** Use the script below (it signs the body with `ZOOM_WEBHOOK_SECRET_TOKEN`).
   - **Body (raw JSON):**

```json
{
  "event": "phone.cdr.completed",
  "payload": {
    "object": {
      "caller_number": "+15550001111",
      "callee_number": "+15551234567",
      "duration": 240,
      "user_name": "John Recruiter",
      "date_time": "2026-03-11T12:00:00Z"
    }
  }
}
```

4. Replace `callee_number` with your job seeker’s phone (e.g. `+15551234567`). Keep it in E.164 form (e.g. `+1` for US).
5. Send the request. You should get **200** and in the backend logs: “Zoom webhook received”, “Call logged successfully” (and “Pending call matched” if you had clicked Call). In the DB, the job seeker’s notes should have a new **call** note.

**If you don’t use Bearer token:** the backend expects an HMAC signature. Use **Option B** (script) to send a correctly signed request, or add `ZOOM_VERIFICATION_TOKEN` and use Bearer in Postman.

### Option B: Node script (signed request)

From the backend folder:

```bash
cd cms_organization_backend
node scripts/send-test-zoom-webhook.js +15551234567
```

- First argument = **callee number** (job seeker’s phone). Must match a job seeker’s `phone` or `mobile_phone` in the DB.
- Optional second argument = base URL (default `http://localhost:8080`).

Example with custom URL:

```bash
node scripts/send-test-zoom-webhook.js +15551234567 http://localhost:8080
```

The script uses `ZOOM_WEBHOOK_SECRET_TOKEN` (or `ZOOM_WEBHOOK_SECRET`) to sign the body. If you use `ZOOM_VERIFICATION_TOKEN` in `.env`, the script still works; the backend accepts either signature or Bearer token.

### What gets logged

- Backend finds the job seeker by `callee_number` (and optionally matches a pending call).
- A note is inserted into **job_seeker_notes** with `note_type = 'call'` and content like:  
  **Call Log** / Number / Duration / Recruiter: John Recruiter / Date.
- If a matching **pending_calls** row existed, it is set to `status = 'completed'`.

**If you get ECONNRESET:** The backend now responds with 200 immediately and processes the event in the background, so the connection should not drop. If you still see ECONNRESET: (1) Confirm the backend is running and the URL is correct (`http://localhost:8080/webhooks/zoom`). (2) Check the backend terminal for any error when you send the request. (3) If using ngrok or a tunnel, try calling `http://localhost:8080` directly from Postman to rule out tunnel issues.
