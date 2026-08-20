# Cron jobs via cron-job.org (free)

Use [cron-job.org](https://cron-job.org) to trigger these API routes at the scheduled times.  
**Base URL:** `https://cms-organization-backend-vq9j.vercel.app`

Set **CRON_SECRET** in your backend env (Vercel → Project → Environment Variables).  
In cron-job.org, add the same value as a **Request Header** (see below).

---

## 1. Archive cleanup (daily at 2:00 AM UTC)

| Field | Value |
|--------|--------|
| **URL** | `https://cms-organization-backend-vq9j.vercel.app/api/cron/archive-cleanup` |
| **Schedule** | Daily at 2:00 AM (e.g. `0 2 * * *` or pick “Every day” 02:00) |
| **Method** | GET (or POST) |

**Request header (required):**  
`Authorization` = `Bearer YOUR_CRON_SECRET`

---

## 2. Task reminders (every 5 minutes)

| Field | Value |
|--------|--------|
| **URL** | `https://cms-organization-backend-vq9j.vercel.app/api/cron/task-reminders` |
| **Schedule** | Every 5 minutes (e.g. `*/5 * * * *`) |
| **Method** | GET (or POST) |

**Request header (required):**  
`Authorization` = `Bearer YOUR_CRON_SECRET`

---

## 3. Delete request retry (every hour)

| Field | Value |
|--------|--------|
| **URL** | `https://cms-organization-backend-vq9j.vercel.app/api/cron/delete-retry` |
| **Schedule** | Every hour (e.g. `0 * * * *` or “Every hour”) |
| **Method** | GET (or POST) |

**Request header (required):**  
`Authorization` = `Bearer YOUR_CRON_SECRET`

---

## Full URLs (copy-paste)

```
https://cms-organization-backend-vq9j.vercel.app/api/cron/archive-cleanup
https://cms-organization-backend-vq9j.vercel.app/api/cron/task-reminders
https://cms-organization-backend-vq9j.vercel.app/api/cron/delete-retry
```

---

## cron-job.org setup steps

1. Sign up at [cron-job.org](https://cron-job.org).
2. Create a new cron job for each URL above.
3. For each job:
   - **URL:** paste the full URL.
   - **Schedule:** set as in the table (daily 2 AM, every 5 min, every hour).
   - **Request method:** GET.
   - **Request headers:** add header name `Authorization`, value `Bearer YOUR_CRON_SECRET` (replace with your real CRON_SECRET from Vercel env).
4. Save and enable the jobs.

Without the `Authorization: Bearer YOUR_CRON_SECRET` header, the API returns **401 Unauthorized**.
